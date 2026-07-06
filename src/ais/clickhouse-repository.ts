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
    minKnots?: number;
    maxKnots?: number;
    /** Optional outer rings ([lng,lat], closed) — per-fix polygon clip. */
    polygons?: number[][][];
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
    const speedFilter =
      opts.minKnots !== undefined || opts.maxKnots !== undefined
        ? "AND speed IS NOT NULL AND speed >= {minKn:Float64} AND speed <= {maxKn:Float64}"
        : "";
    // Per-fix polygon clip: applied in the WHERE clause, so out-of-area fixes
    // are dropped BEFORE the toStartOfInterval bucket downsampling — the point
    // budget (step) is spent only on in-polygon fixes. Same inlining rationale
    // as /density and /effort (buildPolygonFilter). Absent polygon/speed ⇒ both
    // filters are "" and the emitted SQL is identical to the pre-clip query.
    const polyFilter = buildPolygonFilter(opts.polygons);
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
        ${speedFilter}
        ${polyFilter}
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
        ...(speedFilter
          ? { minKn: opts.minKnots ?? 0, maxKn: opts.maxKnots ?? 1_000_000 }
          : {}),
      },
      format: "JSONEachRow",
      // Crisp failure over a slow hang: a polygon clip (per-row pointInPolygon)
      // + speed band over a long window could run long. Matches /density and
      // /effort. The vessel_id IN (...) prefix already bounds the scan to ≤50
      // vessels' partitions, so this is a safety ceiling, not the common path.
      clickhouse_settings: { max_execution_time: 55 },
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
    /** Optional outer rings ([lng,lat], closed) — per-fix polygon clip. */
    polygons?: number[][][];
    limit: number;
  }): Promise<AisDensityResult> {
    const speedFilter =
      opts.minKnots !== undefined || opts.maxKnots !== undefined
        ? "AND speed IS NOT NULL AND speed >= {minKn:Float64} AND speed <= {maxKn:Float64}"
        : "";
    // Per-fix polygon clip (vs the FE's cell-centre clip): applied BEFORE the
    // fixes-DESC LIMIT so out-of-area hotspots can't crowd in-area cells out.
    const polyFilter = buildPolygonFilter(opts.polygons);
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
        ${polyFilter}
        ${vesselFilter}
      GROUP BY cell_lat, cell_lon
      ORDER BY fixes DESC
      LIMIT {lim:UInt32}
    `;
    const rs = await this.client.query({
      query,
      // Same bounded budget as /effort: a polygon-clipped year-to-date scan
      // over the full fleet is the heaviest query this table serves, and the
      // FE calls with a 60 s timeout - fail crisply just under it.
      clickhouse_settings: { max_execution_time: 55 },
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
      clippedToPolygon: (opts.polygons?.length ?? 0) > 0,
      cells: rows.map((r) => ({
        lat: Number(r.cell_lat),
        lng: Number(r.cell_lon),
        fixes: Number(r.fixes),
        vessels: Number(r.vessels),
      })),
      cellCount: rows.length,
    };
  }

  /**
   * Per-vessel fishing-effort aggregation inside a polygon (or bbox) + time
   * range. "Fishing" = fixes inside the speed band; effort duration = sum of
   * gaps between consecutive qualifying fixes per vessel, with gaps above
   * `maxGapSeconds` discarded so AIS coverage holes (or the vessel leaving the
   * area) are never credited as fishing — sparse-AIS vessels are undercounted,
   * never overcounted. Rows are deduped to one per (vessel, event_time) first:
   * that GROUP BY is a prefix of the ReplacingMergeTree sort key, so it is far
   * cheaper than FINAL and collapses pre-merge duplicate rows and multi-source
   * same-second fixes. The bbox always applies as a cheap prefilter; the
   * polygon test (ClickHouse pointInPolygon, (lon,lat) order) refines it.
   * pointInPolygon edge behaviour for fixes exactly on a boundary is
   * implementation-defined — irrelevant at AIS position-jitter scale.
   */
  async getFishingEffort(opts: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
    /** Outer rings, [lng,lat], closed. Holes are not supported. */
    polygons?: number[][][];
    from: string;
    to: string;
    minKnots: number;
    maxKnots: number;
    maxGapSeconds: number;
    vesselIds?: number[];
    limit: number;
  }): Promise<AisEffortResult> {
    const vesselFilter =
      opts.vesselIds && opts.vesselIds.length > 0
        ? "AND vessel_id IN ({ids:Array(Int32)})"
        : "";
    const polyFilter = buildPolygonFilter(opts.polygons);
    const query = `
      WITH fixes AS (
        SELECT vessel_id, event_time
        FROM ais_position_fixes
        WHERE event_time >= {from:DateTime64(3)}
          AND event_time <  {to:DateTime64(3)}
          AND latitude  >= {minLat:Float64} AND latitude  <= {maxLat:Float64}
          AND longitude >= {minLon:Float64} AND longitude <= {maxLon:Float64}
          AND speed IS NOT NULL
          AND speed >= {minKn:Float64} AND speed <= {maxKn:Float64}
          ${polyFilter}
          ${vesselFilter}
        GROUP BY vessel_id, event_time
      ),
      deltas AS (
        SELECT
          vessel_id,
          event_time,
          dateDiff('second',
            lagInFrame(event_time, 1, event_time) OVER (
              PARTITION BY vessel_id ORDER BY event_time
              ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),
            event_time) AS gap_s
        FROM fixes
      )
      SELECT
        vessel_id                     AS vesselId,
        count()                       AS fixes,
        sum(if(gap_s > 0 AND gap_s <= {maxGap:UInt32}, gap_s, 0)) AS fishingSeconds,
        uniqExact(toDate(event_time)) AS activeDays,
        min(event_time)               AS firstSeen,
        max(event_time)               AS lastSeen
      FROM deltas
      GROUP BY vessel_id
      ORDER BY fishingSeconds DESC
      LIMIT 10000
    `;
    const rs = await this.client.query({
      query,
      query_params: {
        from: isoToCh(opts.from),
        to: isoToCh(opts.to),
        minLat: opts.minLat,
        maxLat: opts.maxLat,
        minLon: opts.minLon,
        maxLon: opts.maxLon,
        minKn: opts.minKnots,
        maxKn: opts.maxKnots,
        maxGap: opts.maxGapSeconds,
        ...(vesselFilter ? { ids: opts.vesselIds } : {}),
      },
      clickhouse_settings: { max_execution_time: 55 },
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Array<{
      vesselId: number;
      fixes: string | number;
      fishingSeconds: string | number;
      activeDays: string | number;
      firstSeen: string;
      lastSeen: string;
    }>;
    const all: AisEffortVessel[] = rows.map((r) => {
      const fishingSeconds = Number(r.fishingSeconds);
      return {
        vesselId: Number(r.vesselId),
        fixes: Number(r.fixes),
        fishingSeconds,
        fishingHours: fishingSeconds / 3600,
        fishingDays: fishingSeconds / 86_400,
        activeDays: Number(r.activeDays),
        firstSeen: chToIso(r.firstSeen),
        lastSeen: chToIso(r.lastSeen),
      };
    });
    const totalSeconds = all.reduce((s, v) => s + v.fishingSeconds, 0);
    return {
      from: opts.from,
      to: opts.to,
      speedBand: [opts.minKnots, opts.maxKnots],
      maxGapMinutes: opts.maxGapSeconds / 60,
      bbox: [opts.minLon, opts.minLat, opts.maxLon, opts.maxLat],
      polygonCount: opts.polygons?.length ?? 0,
      vesselIdCount: opts.vesselIds?.length ?? 0,
      totals: {
        vessels: all.length,
        fixes: all.reduce((s, v) => s + v.fixes, 0),
        fishingSeconds: totalSeconds,
        fishingHours: totalSeconds / 3600,
        fishingDays: totalSeconds / 86_400,
      },
      vessels: all.slice(0, opts.limit),
      truncated: all.length > opts.limit,
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
  /** True when fixes were clipped server-side to a polygon. */
  clippedToPolygon: boolean;
  cells: AisDensityCell[];
  cellCount: number;
};

export type AisEffortVessel = {
  vesselId: number;
  fixes: number;
  fishingSeconds: number;
  fishingHours: number;
  /** Gap-capped summed fishing time / 24 h — effort-days. */
  fishingDays: number;
  /** Distinct UTC calendar days with ≥1 qualifying fix in the area. */
  activeDays: number;
  firstSeen: string;
  lastSeen: string;
};

export type AisEffortResult = {
  from: string;
  to: string;
  speedBand: [number, number];
  maxGapMinutes: number;
  bbox: [number, number, number, number];
  polygonCount: number;
  vesselIdCount: number;
  totals: {
    vessels: number;
    fixes: number;
    fishingSeconds: number;
    fishingHours: number;
    fishingDays: number;
  };
  vessels: AisEffortVessel[];
  truncated: boolean;
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

/**
 * OR-chain of pointInPolygon tests over [lng,lat] outer rings, inlined as a
 * SQL literal. Inlining is deliberate: the ClickHouse HTTP client cannot bind
 * an Array(Tuple(Float64, Float64)) query param (it serialises tuples as
 * `[x,y]` where ClickHouse expects `(x,y)`), and pointInPolygon wants a
 * constant polygon anyway. Injection-safe: every vertex is re-validated
 * finite here (routes already range-check) and rendered via Number toString.
 */
function buildPolygonFilter(polygons: number[][][] | undefined): string {
  if (!polygons || polygons.length === 0) return "";
  const parts = polygons.map((ring) => {
    const pts = ring
      .map(([lng, lat]) => {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          throw new Error("polygon vertices must be finite numbers");
        }
        return `(${lng},${lat})`;
      })
      .join(",");
    return `pointInPolygon((longitude, latitude), [${pts}])`;
  });
  return `AND (${parts.join(" OR ")})`;
}

/** ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' → ClickHouse 'YYYY-MM-DD HH:MM:SS.sss' (UTC). */
function isoToCh(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
}

/** ClickHouse 'YYYY-MM-DD HH:MM:SS.sss' (UTC) → ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'. */
function chToIso(value: string): string {
  return `${value.replace(" ", "T")}Z`;
}
