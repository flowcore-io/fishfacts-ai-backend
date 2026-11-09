/**
 * THE data source behind `/api/ais/activity` and `/api/ais/activity/vessels`.
 * Every AIS read those routes make goes through `ActivityDataSource`; routes,
 * cache and response shaping depend on the interface only. That is deliberate:
 * FishFacts now runs its own ClickHouse and every AIS read is meant to move
 * there (Usable Task d40875a7), so repointing this feature is a new
 * implementation of this interface and nothing else.
 *
 * Today's implementation, `ClickhouseActivitySource`, reads OUR ClickHouse
 * (`ais_position_fixes`) and joins the `ais_vessel_registry` copy it owns
 * (filled by vessel-registry.ts). The registry table is part of this source.
 *
 * WHY A REGISTRY TABLE. The speed band is per vessel type, and the type (and
 * the flag) live in FishFacts' MySQL `vessel` registry, not on the fix. So
 * ClickHouse needs the type BEFORE it aggregates. The history spike inlined
 * 9.8 k ids into a 198 KB query; instead the registry is copied into a small
 * table once a day (vessel-registry.ts) and joined here.
 *
 * WHAT A MINUTE IS. Per vessel, consecutive in-band fixes (deduped to one per
 * event_time); each fix is credited the step since the previous one, unless
 * that step exceeds the 30-minute gap rule — then nothing, because time across
 * an AIS hole is not evidence of fishing. That is `/api/ais/effort`'s rule,
 * applied per lattice cell. It is time, never a fix count: the Oct 2024
 * sampling change cut fixes ~3× while the fleet held, and only a time weight
 * is blind to that.
 */
import type { ClickHouseClient } from "@clickhouse/client";
import {
  ACTIVITY_GRID,
  ACTIVITY_MAX_GAP_SECONDS,
  ACTIVITY_SPEED_BANDS,
  type ActivityBbox,
  type ActivityCellRow,
  type ActivityHoverRow,
  type ActivityWindow,
} from "./activity";

/** ClickHouse's own budget for one activity query; over it is `504 upstream_timeout`. */
export const ACTIVITY_QUERY_BUDGET_SECONDS = 30;

/**
 * `@turf/distance`'s earth radius, which the FE hover measures with — so a
 * cell centre that is inside the FE's circle is inside ours.
 */
export const ACTIVITY_EARTH_RADIUS_KM = 6371.0088;

export type ActivityCellsRequest = {
  from: string;
  to: string;
  bbox: ActivityBbox | null;
  flags: string[];
  types: number[];
};

export type ActivityHoverRequest = {
  windows: ActivityWindow[];
  lat: number;
  lon: number;
  radiusKm: number;
  flags: string[];
  types: number[];
};

export type RegistryRow = {
  vessel_id: number;
  type_id: number;
  flag: string;
  name: string | null;
};

type BuiltQuery = { query: string; query_params: Record<string, unknown> };

/**
 * The latest registry snapshot, cut to the requested flags and types. Each
 * refresh inserts a whole snapshot; ReplacingMergeTree folds older versions of
 * a vessel away, and the `snapshot = max` filter hides any that have not been
 * merged yet — and any vessel the registry has since dropped.
 */
export const REGISTRY_CTE = `reg AS (
    SELECT vessel_id, type_id, flag, name
    FROM ais_vessel_registry
    WHERE snapshot = (SELECT max(snapshot) FROM ais_vessel_registry)
      AND type_id IN {types:Array(Int32)}
      AND flag IN {flags:Array(String)}
  )`;

/** The credit rule, in one place for both queries. */
const CREDIT_SECONDS = "if(gap_s > 0 AND gap_s <= {maxGap:UInt32}, gap_s, 0)";

/** The lattice cell, `floor(lon / 0.1)` and `floor(lat / 0.03)` — activity.ts:activityCellIndex. */
const CELL_IX = "toInt32(floor(lo / {gridLon:Float64}))";
const CELL_IY = "toInt32(floor(la / {gridLat:Float64}))";

export type SpeedBandGroup = { min: number; max: number; types: number[] };

/**
 * The requested types grouped by identical speed band — at most three groups
 * today ([0.3, 7.5], [1, 5], [0.3, 5]). One group is one OR-term of the scan
 * predicate, so the band is tested on the raw fixes and the registry join can
 * wait until there is one row per (cell, vessel) instead of one per fix.
 */
export function speedBandGroups(types: number[]): SpeedBandGroup[] {
  const groups = new Map<string, SpeedBandGroup>();
  for (const type of types) {
    const band = ACTIVITY_SPEED_BANDS[type];
    if (!band) throw new Error(`no speed band for vessel type ${type}`);
    const key = `${band[0]}..${band[1]}`;
    const group = groups.get(key) ?? { min: band[0], max: band[1], types: [] };
    group.types.push(type);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * `speed` inside the band of the vessel's own type. The SQL text depends only
 * on how many groups there are; bounds and type lists are bound parameters.
 */
function bandFilter(groups: SpeedBandGroup[]): {
  sql: string;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  const terms = groups.map((g, i) => {
    params[`band${i}Min`] = g.min;
    params[`band${i}Max`] = g.max;
    params[`band${i}Types`] = g.types;
    return `(speed >= {band${i}Min:Float64} AND speed <= {band${i}Max:Float64}
        AND vessel_id IN (SELECT vessel_id FROM reg WHERE type_id IN {band${i}Types:Array(Int32)}))`;
  });
  return {
    sql: `AND speed IS NOT NULL AND (${terms.join("\n        OR ")})`,
    params,
  };
}

function lagGapSeconds(partitionBy: string): string {
  return `dateDiff('second',
        lagInFrame(event_time, 1, event_time) OVER (
          PARTITION BY ${partitionBy} ORDER BY event_time
          ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),
        event_time)`;
}

/**
 * The heatmap query for one window. Exported so tests can guard what reaches prod.
 *
 * The bbox never changes a cell's minutes (contract A3). Each vessel's credit
 * is computed over its WHOLE in-window, in-band track — the gap to its previous
 * fix wherever that fix was — and only then are cells outside the bbox dropped.
 * So a regional cell equals the same cell in the global answer, and the hover
 * total over it. (Clipping fixes to the bbox before the lag credited a vessel
 * that left and came back with the whole time it was away.)
 *
 * The bbox still picks the candidate vessels: one with no in-band fix inside
 * it cannot have a minute in a returned cell, so its track is never read.
 */
export function buildActivityCellsQuery(req: ActivityCellsRequest): BuiltQuery {
  const band = bandFilter(speedBandGroups(req.types));
  const window =
    "event_time >= {from:DateTime64(3)} AND event_time < {to:DateTime64(3)}";
  // Every cell a fix inside the bbox can fall in: [floor(min / g), floor(max / g)].
  const regional = req.bbox
    ? {
        candidates: `AND vessel_id IN (
        SELECT DISTINCT vessel_id FROM ais_position_fixes
        WHERE ${window}
          AND latitude >= {minLat:Float64} AND latitude <= {maxLat:Float64}
          AND longitude >= {minLon:Float64} AND longitude <= {maxLon:Float64}
          ${band.sql})`,
        cells: `WHERE ix >= toInt32(floor({minLon:Float64} / {gridLon:Float64}))
      AND ix <= toInt32(floor({maxLon:Float64} / {gridLon:Float64}))
      AND iy >= toInt32(floor({minLat:Float64} / {gridLat:Float64}))
      AND iy <= toInt32(floor({maxLat:Float64} / {gridLat:Float64}))`,
      }
    : { candidates: "", cells: "" };
  const query = `
  WITH
  ${REGISTRY_CTE},
  fx AS (
    SELECT vessel_id, event_time, any((latitude, longitude)) AS p
    FROM ais_position_fixes
    WHERE ${window}
      ${regional.candidates}
      ${band.sql}
    GROUP BY vessel_id, event_time
  ),
  credited AS (
    SELECT vessel_id, tupleElement(p, 1) AS la, tupleElement(p, 2) AS lo,
      ${lagGapSeconds("vessel_id")} AS gap_s
    FROM fx
  ),
  per_vessel AS (
    SELECT ${CELL_IX} AS ix, ${CELL_IY} AS iy, vessel_id,
      sum(${CREDIT_SECONDS}) / 60 AS minutes
    FROM credited
    ${regional.cells}
    GROUP BY ix, iy, vessel_id
    HAVING minutes > 0
  )
  SELECT ix, iy, count() AS vessels,
    groupArray((reg.flag, reg.type_id, per_vessel.minutes)) AS w
  FROM per_vessel INNER JOIN reg ON per_vessel.vessel_id = reg.vessel_id
  GROUP BY ix, iy`;
  return {
    query,
    query_params: {
      from: isoToCh(req.from),
      to: isoToCh(req.to),
      flags: req.flags,
      types: req.types,
      ...band.params,
      maxGap: ACTIVITY_MAX_GAP_SECONDS,
      gridLon: ACTIVITY_GRID.lonDeg,
      gridLat: ACTIVITY_GRID.latDeg,
      ...(req.bbox
        ? {
            minLon: req.bbox[0],
            minLat: req.bbox[1],
            maxLon: req.bbox[2],
            maxLat: req.bbox[3],
          }
        : {}),
    },
  };
}

/** The hover prefilter: a latitude band and one or two longitude intervals. */
export type HoverPrefilter = {
  minLat: number;
  maxLat: number;
  /** Inclusive `[min, max]` intervals; two when the circle crosses ±180°. */
  lonRanges: Array<[number, number]>;
};

/**
 * A lat/lon area that holds every fix whose CELL CENTRE can be within
 * `radiusKm` of the point: the circle's extent plus a cell each way. Only a
 * prefilter (the exact haversine runs after); generous on purpose. A circle
 * that crosses the antimeridian wraps to the far side, so its longitudes are
 * split into two intervals rather than clamped at ±180°.
 */
export function hoverPrefilter(
  lat: number,
  lon: number,
  radiusKm: number,
): HoverPrefilter {
  const kmPerDegLat = (Math.PI / 180) * ACTIVITY_EARTH_RADIUS_KM;
  const dLat = radiusKm / kmPerDegLat + ACTIVITY_GRID.latDeg;
  const minLat = Math.max(-90, lat - dLat);
  const maxLat = Math.min(90, lat + dLat);
  const widestLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const cos = Math.cos((widestLat * Math.PI) / 180);
  const everyLon: Array<[number, number]> = [[-180, 180]];
  if (cos < 0.01) return { minLat, maxLat, lonRanges: everyLon };
  const dLon = radiusKm / (kmPerDegLat * cos) + ACTIVITY_GRID.lonDeg;
  if (dLon >= 180) return { minLat, maxLat, lonRanges: everyLon };
  const west = lon - dLon;
  const east = lon + dLon;
  const lonRanges: Array<[number, number]> =
    west < -180
      ? [
          [-180, east],
          [west + 360, 180],
        ]
      : east > 180
        ? [
            [west, 180],
            [-180, east - 360],
          ]
        : [[west, east]];
  return { minLat, maxLat, lonRanges };
}

/**
 * The hover's per-vessel minutes, per window.
 *
 * Area rule (contract §2): a fix counts when the centre of ITS LATTICE CELL is
 * within `radiusKm` of the point — the same cells the FE sums heatmap weights
 * over. The gap credit is computed over each candidate vessel's whole in-band
 * track in the window, BEFORE the area cut, exactly as the heatmap computes it,
 * so a cell's minutes here equal its weights there. (Cutting first would let a
 * vessel that left the circle and came back be credited the time it was away.) *
 * Each fix belongs to one window (`multiIf`): the windows are disjoint, which
 * parseActivityVesselsQuery enforces (contract A2).
 */
export function buildActivityHoverQuery(req: ActivityHoverRequest): BuiltQuery {
  const windowParams: Record<string, string> = {};
  const inWindow: string[] = [];
  const windowIndex: string[] = [];
  req.windows.forEach((w, i) => {
    windowParams[`w${i}f`] = isoToCh(w.from);
    windowParams[`w${i}t`] = isoToCh(w.to);
    const test = `(event_time >= {w${i}f:DateTime64(3)} AND event_time < {w${i}t:DateTime64(3)})`;
    inWindow.push(test);
    windowIndex.push(test, String(i));
  });
  const anyWindow = `(${inWindow.join(" OR ")})`;
  const area = hoverPrefilter(req.lat, req.lon, req.radiusKm);
  const areaParams: Record<string, number> = {
    minLat: area.minLat,
    maxLat: area.maxLat,
  };
  const lonTerms = area.lonRanges.map(([min, max], i) => {
    areaParams[`lon${i}Min`] = min;
    areaParams[`lon${i}Max`] = max;
    return `(longitude >= {lon${i}Min:Float64} AND longitude <= {lon${i}Max:Float64})`;
  });
  const band = bandFilter(speedBandGroups(req.types));
  const query = `
  WITH
  ${REGISTRY_CTE},
  cand AS (
    SELECT DISTINCT vessel_id
    FROM ais_position_fixes
    WHERE ${anyWindow}
      AND latitude >= {minLat:Float64} AND latitude <= {maxLat:Float64}
      AND (${lonTerms.join(" OR ")})
      ${band.sql}
  ),
  fx AS (
    SELECT vessel_id, multiIf(${windowIndex.join(", ")}, -1) AS w, event_time,
      any((latitude, longitude)) AS p
    FROM ais_position_fixes
    WHERE ${anyWindow}
      AND vessel_id IN (SELECT vessel_id FROM cand)
      ${band.sql}
    GROUP BY vessel_id, w, event_time
  ),
  credited AS (
    SELECT vessel_id, w, tupleElement(p, 1) AS la, tupleElement(p, 2) AS lo,
      ${lagGapSeconds("vessel_id, w")} AS gap_s
    FROM fx
  ),
  centred AS (
    SELECT vessel_id, w, gap_s,
      round((${CELL_IX} + 0.5) * {gridLon:Float64}, 3) AS clon,
      round((${CELL_IY} + 0.5) * {gridLat:Float64}, 3) AS clat
    FROM credited
  ),
  per_vessel AS (
    SELECT w, vessel_id, sum(${CREDIT_SECONDS}) / 60 AS minutes
    FROM centred
    WHERE 2 * {earthKm:Float64} * asin(sqrt(
        pow(sin(radians(clat - {lat:Float64}) / 2), 2)
        + cos(radians({lat:Float64})) * cos(radians(clat))
          * pow(sin(radians(clon - {lon:Float64}) / 2), 2)
      )) <= {radiusKm:Float64}
    GROUP BY w, vessel_id
    HAVING minutes > 0
  )
  SELECT per_vessel.w AS w, per_vessel.vessel_id AS vessel_id, reg.name AS name,
    reg.flag AS flag, reg.type_id AS type_id, per_vessel.minutes AS minutes
  FROM per_vessel INNER JOIN reg ON per_vessel.vessel_id = reg.vessel_id`;
  return {
    query,
    query_params: {
      ...windowParams,
      flags: req.flags,
      types: req.types,
      ...band.params,
      maxGap: ACTIVITY_MAX_GAP_SECONDS,
      gridLon: ACTIVITY_GRID.lonDeg,
      gridLat: ACTIVITY_GRID.latDeg,
      ...areaParams,
      lat: req.lat,
      lon: req.lon,
      radiusKm: req.radiusKm,
      earthKm: ACTIVITY_EARTH_RADIUS_KM,
    },
  };
}

/** What the activity routes need from wherever AIS lives. */
export interface ActivityDataSource {
  /** One window's heatmap: one row per lattice cell, per-vessel minutes inside. */
  getActivityCells(req: ActivityCellsRequest): Promise<ActivityCellRow[]>;
  /** Hover: per (window, vessel) minutes for cells whose centre is in the circle. */
  getHoverRows(req: ActivityHoverRequest): Promise<ActivityHoverRow[]>;
  /**
   * Can this source answer truthfully right now? `false` makes the routes
   * answer 503 instead of caching an empty past as immutable.
   */
  isReady(): Promise<boolean>;
}

export class ClickhouseActivitySource implements ActivityDataSource {
  constructor(private readonly client: ClickHouseClient) {}

  async getActivityCells(
    req: ActivityCellsRequest,
  ): Promise<ActivityCellRow[]> {
    const built = buildActivityCellsQuery(req);
    const rs = await this.client.query({
      ...built,
      format: "JSONCompactEachRow",
      clickhouse_settings: {
        max_execution_time: ACTIVITY_QUERY_BUDGET_SECONDS,
      },
    });
    return (await rs.json()) as ActivityCellRow[];
  }

  async getHoverRows(req: ActivityHoverRequest): Promise<ActivityHoverRow[]> {
    const built = buildActivityHoverQuery(req);
    const rs = await this.client.query({
      ...built,
      format: "JSONEachRow",
      clickhouse_settings: {
        max_execution_time: ACTIVITY_QUERY_BUDGET_SECONDS,
      },
    });
    const rows = (await rs.json()) as Array<{
      w: number;
      vessel_id: number;
      name: string | null;
      flag: string;
      type_id: number;
      minutes: number | string;
    }>;
    return rows.map((r) => ({
      window: Number(r.w),
      vesselId: Number(r.vessel_id),
      name: r.name?.trim() ? r.name.trim() : null,
      flag: r.flag,
      typeId: Number(r.type_id),
      minutes: Number(r.minutes),
    }));
  }

  /** Ready once a registry snapshot exists: without one every answer is empty. */
  async isReady(): Promise<boolean> {
    return (await this.registrySize()) > 0;
  }

  /** Vessels in the latest registry snapshot (0 = never loaded). */
  async registrySize(): Promise<number> {
    const rs = await this.client.query({
      query: `SELECT count() AS n FROM ais_vessel_registry
        WHERE snapshot = (SELECT max(snapshot) FROM ais_vessel_registry)`,
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Array<{ n: string | number }>;
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Writes one whole snapshot in a single INSERT (one block, so readers see
   * all of it or none of it — the `snapshot = max` filter flips atomically).
   */
  async writeRegistrySnapshot(
    rows: RegistryRow[],
    snapshotMs: number,
  ): Promise<void> {
    if (rows.length === 0) return;
    const snapshot = isoToCh(new Date(snapshotMs).toISOString());
    await this.client.insert({
      table: "ais_vessel_registry",
      values: rows.map((r) => ({ ...r, snapshot })),
      format: "JSONEachRow",
    });
  }
}

/** ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' → ClickHouse 'YYYY-MM-DD HH:MM:SS.sss' (UTC). */
function isoToCh(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace("Z", "");
}
