import type { Env } from "@/env";
import type { AisPositionFixObserved } from "@/events/contracts";
import type { ClickHouseClient } from "@clickhouse/client";

const TABLE = "ais_position_fixes";

type ChRow = {
  source_id: number;
  vessel_id: number;
  vessel_source_id: number | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  course: number | null;
  status: string | null;
  event_time: string;
  ingest_time: string;
  observed_at: string;
  source: string;
};

/**
 * Buffered ClickHouse writer. One worker (cluster mode = one per pod) owns one
 * buffer; flush batches many fixes into a single INSERT — ClickHouse degrades
 * badly with many tiny inserts. Idempotency is handled by the ReplacingMergeTree
 * sort key, so at-least-once redelivery is safe.
 */
export class AisClickhouseRepository {
  private buffer: ChRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchRows: number;

  constructor(
    private readonly client: ClickHouseClient,
    env: Env,
  ) {
    this.batchRows = env.AIS_CH_BATCH_ROWS;
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        console.error("[AIS] ClickHouse timed flush failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }, env.AIS_CH_FLUSH_MS);
  }

  async enqueue(payload: AisPositionFixObserved): Promise<void> {
    this.buffer.push(toRow(payload));
    if (this.buffer.length >= this.batchRows) await this.flush();
  }

  /** Insert + clear the buffer. Throws on failure so the pump retries/redelivers. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.client.insert({
        table: TABLE,
        values: rows,
        format: "JSONEachRow",
      });
    } catch (err) {
      // Put rows back so a later flush / redelivery retries them.
      this.buffer = rows.concat(this.buffer);
      throw err;
    }
  }

  /** Total rows in ClickHouse (pre-merge; ReplacingMergeTree may hold dupes). */
  async totalRows(): Promise<number> {
    const rs = await this.client.query({
      query: `SELECT count() AS c FROM ${TABLE}`,
      format: "JSONEachRow",
    });
    const data = (await rs.json()) as Array<{ c: string | number }>;
    return Number(data[0]?.c ?? 0);
  }

  /** Row count in ClickHouse for an hour bucket — used by the backfill skip-check. */
  async countBucket(bucketStartIso: string): Promise<number> {
    const start = isoToCh(bucketStartIso);
    const end = isoToCh(
      new Date(new Date(bucketStartIso).getTime() + 3_600_000).toISOString(),
    );
    const rs = await this.client.query({
      query: `SELECT count() AS c FROM ${TABLE} WHERE event_time >= {start:DateTime64(3)} AND event_time < {end:DateTime64(3)}`,
      query_params: { start, end },
      format: "JSONEachRow",
    });
    const data = (await rs.json()) as Array<{ c: string | number }>;
    return Number(data[0]?.c ?? 0);
  }

  /**
   * Vessel tracks for one or more vessels over a time window. Downsamples
   * server-side to ~maxPointsPerVessel by taking the latest fix per time bucket
   * (bucket = window / maxPoints), so long multi-vessel windows stay bounded.
   * Returns one entry per requested vessel, points ascending by time.
   */
  async getTracks(opts: {
    vesselIds: number[];
    from: string;
    to: string;
    maxPointsPerVessel: number;
    statuses?: string[];
  }): Promise<AisTracksResult> {
    const windowSec = Math.max(
      1,
      Math.floor(
        (new Date(opts.to).getTime() - new Date(opts.from).getTime()) / 1000,
      ),
    );
    const step = Math.max(1, Math.floor(windowSec / opts.maxPointsPerVessel));
    const statusFilter = opts.statuses?.length
      ? "AND status IN ({statuses:Array(String)})"
      : "";
    const query = `
      SELECT
        vessel_id                     AS vesselId,
        max(event_time)               AS t,
        argMax(latitude, event_time)  AS lat,
        argMax(longitude, event_time) AS lon,
        argMax(speed, event_time)     AS speed,
        argMax(heading, event_time)   AS heading,
        argMax(course, event_time)    AS course,
        argMax(status, event_time)    AS last_status
      FROM ais_position_fixes
      WHERE vessel_id IN ({ids:Array(Int32)})
        AND event_time >= {from:DateTime64(3)}
        AND event_time <  {to:DateTime64(3)}
        ${statusFilter}
      GROUP BY vessel_id, toStartOfInterval(event_time, INTERVAL ${step} SECOND)
      ORDER BY vessel_id, t
    `;
    const rs = await this.client.query({
      query,
      query_params: {
        ids: opts.vesselIds,
        from: isoToCh(opts.from),
        to: isoToCh(opts.to),
        ...(opts.statuses?.length ? { statuses: opts.statuses } : {}),
      },
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Array<{
      vesselId: number;
      t: string;
      lat: number;
      lon: number;
      speed: number | null;
      heading: number | null;
      course: number | null;
      last_status: string | null;
    }>;
    const byVessel = new Map<number, AisTrackPoint[]>();
    for (const r of rows) {
      const arr = byVessel.get(r.vesselId) ?? [];
      arr.push({
        t: chToIso(r.t),
        lat: r.lat,
        lon: r.lon,
        speed: r.speed,
        heading: r.heading,
        course: r.course,
        status: r.last_status,
      });
      byVessel.set(r.vesselId, arr);
    }
    return {
      from: opts.from,
      to: opts.to,
      vessels: opts.vesselIds.map((id) => {
        const points = byVessel.get(id) ?? [];
        return {
          vesselId: id,
          pointCount: points.length,
          last: points.at(-1) ?? null,
          points,
        };
      }),
    };
  }

  /**
   * Fleet-density grid over a bbox + time window. Aggregates position fixes into
   * `gridDeg`-sized cells (count of fixes + distinct vessels), optionally
   * restricted to a speed band (e.g. trawling speeds = "actively fishing").
   * Powers the "exclude where the fleet is fishing" recommendation signal.
   * Counts are pre-merge (ReplacingMergeTree) so treat as an approximate density,
   * not an exact fix count — fine for ranking cells.
   */
  async getDensityGrid(opts: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
    gridDeg: number;
    from: string;
    to: string;
    minKnots?: number;
    maxKnots?: number;
    vesselIds?: number[];
    limit: number;
  }): Promise<AisDensityResult> {
    const speedFilter =
      opts.minKnots !== undefined || opts.maxKnots !== undefined
        ? "AND speed IS NOT NULL AND speed >= {minKn:Float64} AND speed <= {maxKn:Float64}"
        : "";
    // Optional gear/vessel-type filter: the FE resolves a vessel type (e.g.
    // longliners) to its FF vessel ids and passes them here. vessel_id is the
    // leading ORDER BY key, so the IN filter is cheap.
    const vesselFilter =
      opts.vesselIds && opts.vesselIds.length > 0
        ? "AND vessel_id IN ({ids:Array(Int32)})"
        : "";
    const query = `
      SELECT
        round(latitude  / {g:Float64}) * {g:Float64} AS cell_lat,
        round(longitude / {g:Float64}) * {g:Float64} AS cell_lon,
        count()              AS fixes,
        uniqExact(vessel_id) AS vessels
      FROM ais_position_fixes
      WHERE event_time >= {from:DateTime64(3)}
        AND event_time <  {to:DateTime64(3)}
        AND latitude  >= {minLat:Float64} AND latitude  <= {maxLat:Float64}
        AND longitude >= {minLon:Float64} AND longitude <= {maxLon:Float64}
        ${speedFilter}
        ${vesselFilter}
      GROUP BY cell_lat, cell_lon
      ORDER BY fixes DESC
      LIMIT {lim:UInt32}
    `;
    const rs = await this.client.query({
      query,
      query_params: {
        g: opts.gridDeg,
        from: isoToCh(opts.from),
        to: isoToCh(opts.to),
        minLat: opts.minLat,
        maxLat: opts.maxLat,
        minLon: opts.minLon,
        maxLon: opts.maxLon,
        lim: opts.limit,
        ...(speedFilter
          ? { minKn: opts.minKnots ?? 0, maxKn: opts.maxKnots ?? 1_000_000 }
          : {}),
        ...(vesselFilter ? { ids: opts.vesselIds } : {}),
      },
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Array<{
      cell_lat: number;
      cell_lon: number;
      fixes: string | number;
      vessels: string | number;
    }>;
    return {
      gridDeg: opts.gridDeg,
      from: opts.from,
      to: opts.to,
      speedBand:
        opts.minKnots !== undefined || opts.maxKnots !== undefined
          ? [opts.minKnots ?? 0, opts.maxKnots ?? null]
          : null,
      vesselIdCount: opts.vesselIds?.length ?? 0,
      cells: rows.map((r) => ({
        lat: Number(r.cell_lat),
        lng: Number(r.cell_lon),
        fixes: Number(r.fixes),
        vessels: Number(r.vessels),
      })),
      cellCount: rows.length,
    };
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.client.close();
  }
}

export type AisDensityCell = {
  lat: number;
  lng: number;
  fixes: number;
  vessels: number;
};

export type AisDensityResult = {
  gridDeg: number;
  from: string;
  to: string;
  speedBand: [number, number | null] | null;
  /** Number of vessel ids the grid was restricted to (0 = all vessels). */
  vesselIdCount: number;
  cells: AisDensityCell[];
  cellCount: number;
};

export type AisTrackPoint = {
  t: string;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  course: number | null;
  status: string | null;
};

export type AisVesselTrack = {
  vesselId: number;
  pointCount: number;
  last: AisTrackPoint | null;
  points: AisTrackPoint[];
};

export type AisTracksResult = {
  from: string;
  to: string;
  vessels: AisVesselTrack[];
};

function toRow(p: AisPositionFixObserved): ChRow {
  return {
    source_id: p.sourceId,
    vessel_id: p.vesselId,
    vessel_source_id: p.vesselSourceId,
    latitude: p.latitude,
    longitude: p.longitude,
    speed: p.speed,
    heading: p.heading,
    course: p.course,
    status: p.status,
    event_time: isoToCh(p.eventTime),
    ingest_time: isoToCh(p.ingestTime),
    observed_at: isoToCh(p.observedAt),
    source: p.source,
  };
}

/** ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' → ClickHouse 'YYYY-MM-DD HH:MM:SS.sss' (UTC). */
function isoToCh(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
}

/** ClickHouse 'YYYY-MM-DD HH:MM:SS.sss' (UTC) → ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'. */
function chToIso(value: string): string {
  return `${value.replace(" ", "T")}Z`;
}
