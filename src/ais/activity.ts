/**
 * Fishing Activity history — the pure half of `/api/ais/activity` and
 * `/api/ais/activity/vessels`: parameters, guard rails, the FishFacts lattice,
 * cache keys, and the response shapes. Everything here is deterministic and
 * takes no database, so the rules the front end depends on are pinned by
 * unit tests rather than by looking at a map.
 *
 * The heatmap answers in exactly the shape of FishFacts' own
 * `fishing_roll*d_*.geojson` files — `{weights:{<flag>:{<typeId>:<minutes>}}}`
 * points on a 0.1° lon × 0.03° lat lattice — so fishfacts-fe renders a past
 * season with the paint and filters it already has. The contract the two
 * repos agreed lives in the run folder as CONTRACT.md; its codes and limits
 * are restated here as named constants, never inline.
 */
import { AIS_RUN_MAX_GAP_MINUTES } from "./fishing-runs";

/** FishFacts' heatmap lattice, in degrees: 0.1° of longitude × 0.03° of latitude. */
export const ACTIVITY_GRID = { lonDeg: 0.1, latDeg: 0.03 } as const;

/**
 * The 11 flags fishfacts-fe's Fishing Activity filter offers
 * (`FISHING_ACTIVITY_FILTER_OPTIONS.countries`), in its order. A request
 * without `flags` gets these; any other code is a 400, because a flag the FE
 * cannot show is a flag nobody asked for.
 */
export const ACTIVITY_DEFAULT_FLAGS = [
  "FO",
  "NO",
  "IS",
  "GL",
  "DK",
  "SE",
  "GB",
  "IE",
  "CA",
  "RU",
  "NZ",
] as const;

/**
 * The 9 vessel types the FE filter offers (`vesselTypes`), in its order:
 * pelagic, combined seiner, freezing trawler, trawler, long liner, coast <20 m,
 * coast >20 m, krill, crabs and shellfish. These are FISHING types only — the
 * oil-field standby vessels that top an unfiltered density map are not among
 * them, which is why both endpoints refuse any other id.
 */
export const ACTIVITY_DEFAULT_TYPES = [2, 28, 4, 3, 5, 10, 29, 8, 6] as const;

/**
 * Speed band per vessel type, knots, inclusive at both ends.
 *
 * A mirror of fishfacts-fe `FISHING_SPEED_MAP`
 * (`src/pages/Map/components/tracks/constants.ts`), which is what FishFacts'
 * own activity files are cut with; types 28 and 29 are absent from that map
 * and take its fallback `FISHING_ACTIVITY_RANGE` [0.3, 7.5]. This is the
 * Activity layer's band and is deliberately NOT `AIS_FISHING_*_KNOTS` from
 * fishing-runs.ts: that one is the effort/Sildelaget definition (0.3–5.5) and
 * answers a different question. Changing either is a one-line edit here.
 */
export const ACTIVITY_SPEED_BANDS: Readonly<
  Record<number, readonly [number, number]>
> = {
  2: [0.3, 7.5],
  3: [1, 5],
  4: [1, 5],
  5: [1, 5],
  6: [0.3, 5],
  8: [1, 5],
  10: [1, 5],
  28: [0.3, 7.5],
  29: [0.3, 7.5],
};

/**
 * A step between consecutive in-band fixes longer than this credits nothing:
 * the vessel's time across an AIS hole is not evidence of fishing. The same
 * rule, and the same constant, as `/api/ais/effort` and the Sildelaget runs.
 */
export const ACTIVITY_MAX_GAP_SECONDS = AIS_RUN_MAX_GAP_MINUTES * 60;

/** Earliest instant either endpoint answers for (contract §1). */
export const ACTIVITY_MIN_FROM_MS = Date.parse("2021-01-01T00:00:00Z");

const DAY_MS = 86_400_000;
/** Any window longer than this is `422 window_too_long`. */
export const ACTIVITY_MAX_WINDOW_DAYS = 92;
/** Longer than this needs a regional bbox, else `422 global_window_too_long`. */
export const ACTIVITY_MAX_GLOBAL_WINDOW_DAYS = 31;
/** The largest bbox (deg²) that counts as "regional"; the FE's North Atlantic is 1 625. */
export const ACTIVITY_MAX_REGIONAL_BBOX_DEG2 = 2_500;
/** A window ending before now minus this never changes again. */
export const ACTIVITY_IMMUTABLE_AFTER_MS = DAY_MS;

/** Hover list: at most this many rows; counts and totals still cover everyone. */
export const ACTIVITY_HOVER_MAX_ROWS = 50;
export const ACTIVITY_HOVER_MAX_WINDOWS = 6;
export const ACTIVITY_HOVER_MAX_RADIUS_KM = 100;

/**
 * Bumped whenever a rule above changes what a cached answer would contain
 * (band, gap, lattice, registry mapping). Cached past windows are otherwise
 * immutable, so this is the only thing that retires them.
 */
export const ACTIVITY_RULES_VERSION = 1;

export type ActivityErrorCode =
  | "bad_request"
  | "window_too_long"
  | "global_window_too_long"
  | "upstream_timeout"
  | "upstream_unavailable";

/** Contract §3: `{ error, code }` with the status that goes with the code. */
export type ActivityError = {
  status: 400 | 422 | 503 | 504;
  code: ActivityErrorCode;
  error: string;
};

/** [minLon, minLat, maxLon, maxLat] */
export type ActivityBbox = [number, number, number, number];

export type ActivityQuery = {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  bbox: ActivityBbox | null;
  /** Sorted, distinct. */
  flags: string[];
  /** Sorted ascending, distinct. */
  types: number[];
};

export type ActivityWindow = { from: string; to: string };

export type ActivityVesselsQuery = {
  /** Sorted by `from`, distinct. */
  windows: ActivityWindow[];
  /** Rounded to 3 dp — the value the query runs with, so the cache key is honest. */
  lat: number;
  lon: number;
  /** Rounded to 1 dp, for the same reason. */
  radiusKm: number;
  flags: string[];
  types: number[];
};

function badRequest(error: string): ActivityError {
  return { status: 400, code: "bad_request", error };
}

/**
 * An ISO-8601 instant with a time and a zone — `2025-09-10T00:00:00Z`, with
 * optional seconds, milliseconds, or a `±hh:mm` offset. A bare date is refused:
 * `Date.parse` would read it as UTC midnight, which is a guess about intent.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(
  raw: string | null,
  name: string,
): number | ActivityError {
  const value = raw?.trim();
  if (!value) return badRequest(`${name} is required (ISO-8601 UTC instant)`);
  const ms = ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    return badRequest(
      `${name} must be an ISO-8601 instant, e.g. 2025-09-10T00:00:00Z`,
    );
  }
  return ms;
}

/** Contract §1 `from`/`to` rules plus the 92-day cap, which applies everywhere. */
function parseWindow(
  fromRaw: string | null,
  toRaw: string | null,
  nowMs: number,
  label = "",
): { fromMs: number; toMs: number } | ActivityError {
  const fromMs = parseInstant(fromRaw, `${label}from`);
  if (typeof fromMs !== "number") return fromMs;
  const toMs = parseInstant(toRaw, `${label}to`);
  if (typeof toMs !== "number") return toMs;
  if (fromMs >= toMs) return badRequest(`${label}from must be before to`);
  if (fromMs < ACTIVITY_MIN_FROM_MS) {
    return badRequest(`${label}from must be on or after 2021-01-01T00:00:00Z`);
  }
  if (toMs > nowMs) return badRequest(`${label}to must not be in the future`);
  if (toMs - fromMs > ACTIVITY_MAX_WINDOW_DAYS * DAY_MS) {
    return {
      status: 422,
      code: "window_too_long",
      error: `Windows are limited to ${ACTIVITY_MAX_WINDOW_DAYS} days`,
    };
  }
  return { fromMs, toMs };
}

function parseBbox(raw: string | null): ActivityBbox | null | ActivityError {
  if (raw == null) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return badRequest(
      "bbox must be 4 numbers: minLon,minLat,maxLon,maxLat (degrees)",
    );
  }
  const [minLon, minLat, maxLon, maxLat] = parts as ActivityBbox;
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    return badRequest("bbox is out of range, or min >= max");
  }
  return [minLon, minLat, maxLon, maxLat];
}

const KNOWN_FLAGS = new Set<string>(ACTIVITY_DEFAULT_FLAGS);
const KNOWN_TYPES = new Set<number>(ACTIVITY_DEFAULT_TYPES);

function parseFlags(raw: string | null): string[] | ActivityError {
  if (raw == null) return [...ACTIVITY_DEFAULT_FLAGS].sort();
  const flags = new Set<string>();
  for (const part of raw.split(",")) {
    const flag = part.trim().toUpperCase();
    if (!flag) continue;
    if (!KNOWN_FLAGS.has(flag)) return badRequest(`unknown flag: ${flag}`);
    flags.add(flag);
  }
  if (flags.size === 0) return badRequest("flags must name at least one flag");
  return [...flags].sort();
}

function parseTypes(raw: string | null): number[] | ActivityError {
  if (raw == null) return [...ACTIVITY_DEFAULT_TYPES].sort((a, b) => a - b);
  const types = new Set<number>();
  for (const part of raw.split(",")) {
    const text = part.trim();
    if (!text) continue;
    const type = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!KNOWN_TYPES.has(type))
      return badRequest(`unknown vessel type: ${text}`);
    types.add(type);
  }
  if (types.size === 0) return badRequest("types must name at least one type");
  return [...types].sort((a, b) => a - b);
}

/** Contract §1. `nowMs` is a parameter so the guard rails are testable at their edges. */
export function parseActivityQuery(
  params: URLSearchParams,
  nowMs: number,
): ActivityQuery | ActivityError {
  const window = parseWindow(params.get("from"), params.get("to"), nowMs);
  if ("code" in window) return window;
  const bbox = parseBbox(params.get("bbox"));
  if (bbox && "code" in bbox) return bbox;
  const flags = parseFlags(params.get("flags"));
  if ("code" in flags) return flags;
  const types = parseTypes(params.get("types"));
  if ("code" in types) return types;

  if (
    window.toMs - window.fromMs > ACTIVITY_MAX_GLOBAL_WINDOW_DAYS * DAY_MS &&
    (!bbox || bboxAreaDeg2(bbox) > ACTIVITY_MAX_REGIONAL_BBOX_DEG2)
  ) {
    return {
      status: 422,
      code: "global_window_too_long",
      error: `Windows over ${ACTIVITY_MAX_GLOBAL_WINDOW_DAYS} days need a bbox of at most ${ACTIVITY_MAX_REGIONAL_BBOX_DEG2} deg²`,
    };
  }

  return {
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    fromMs: window.fromMs,
    toMs: window.toMs,
    bbox,
    flags,
    types,
  };
}

export function bboxAreaDeg2([minLon, minLat, maxLon, maxLat]: ActivityBbox) {
  return (maxLon - minLon) * (maxLat - minLat);
}

function parseNumber(
  raw: string | null,
  name: string,
  min: number,
  max: number,
): number | ActivityError {
  const text = raw?.trim();
  const n = text ? Number(text) : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) {
    return badRequest(`${name} must be a number in [${min}, ${max}]`);
  }
  return n;
}

const round = (value: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
};

/** Contract §2. */
export function parseActivityVesselsQuery(
  params: URLSearchParams,
  nowMs: number,
): ActivityVesselsQuery | ActivityError {
  const raw = params.get("windows")?.trim();
  if (!raw) return badRequest("windows is required: from/to,from/to,…");
  const pairs = raw.split(",").filter((s) => s.trim());
  if (pairs.length < 1 || pairs.length > ACTIVITY_HOVER_MAX_WINDOWS) {
    return badRequest(
      `windows must hold 1 to ${ACTIVITY_HOVER_MAX_WINDOWS} from/to pairs`,
    );
  }
  const byKey = new Map<string, ActivityWindow & { fromMs: number }>();
  for (const [i, pair] of pairs.entries()) {
    const halves = pair.split("/");
    if (halves.length !== 2) {
      return badRequest(`windows[${i}] must be from/to`);
    }
    const window = parseWindow(
      halves[0] ?? null,
      halves[1] ?? null,
      nowMs,
      `windows[${i}].`,
    );
    if ("code" in window) return window;
    const from = new Date(window.fromMs).toISOString();
    const to = new Date(window.toMs).toISOString();
    byKey.set(`${from}/${to}`, { from, to, fromMs: window.fromMs });
  }
  const windows = [...byKey.values()]
    .sort((a, b) => a.fromMs - b.fromMs || a.to.localeCompare(b.to))
    .map(({ from, to }) => ({ from, to }));

  const lat = parseNumber(params.get("lat"), "lat", -90, 90);
  if (typeof lat !== "number") return lat;
  const lon = parseNumber(params.get("lon"), "lon", -180, 180);
  if (typeof lon !== "number") return lon;
  const radiusKm = parseNumber(
    params.get("radiusKm"),
    "radiusKm",
    0,
    ACTIVITY_HOVER_MAX_RADIUS_KM,
  );
  if (typeof radiusKm !== "number") return radiusKm;
  // 0 < r: the range check above admits 0, and so does rounding 0.04 down.
  const roundedRadius = round(radiusKm, 1);
  if (roundedRadius <= 0) {
    return badRequest(
      `radiusKm must be a number in (0, ${ACTIVITY_HOVER_MAX_RADIUS_KM}]`,
    );
  }
  const flags = parseFlags(params.get("flags"));
  if ("code" in flags) return flags;
  const types = parseTypes(params.get("types"));
  if ("code" in types) return types;

  return {
    windows,
    lat: round(lat, 3),
    lon: round(lon, 3),
    radiusKm: roundedRadius,
    flags,
    types,
  };
}

/** Past windows never change; anything that ends within the last day may still fill in. */
export function isImmutableWindow(toMs: number, nowMs: number): boolean {
  return toMs < nowMs - ACTIVITY_IMMUTABLE_AFTER_MS;
}

const gridKey = `${ACTIVITY_GRID.lonDeg}x${ACTIVITY_GRID.latDeg}`;

/**
 * Normalised `(from, to, bbox, grid, flags, types)`. Inputs are already
 * canonical (ISO instants, sorted distinct CSVs, numbers re-rendered), so two
 * spellings of one question share an entry.
 */
export function activityCacheKey(q: ActivityQuery): string {
  return [
    `activity:v${ACTIVITY_RULES_VERSION}`,
    `${q.from}/${q.to}`,
    q.bbox ? q.bbox.map(String).join(",") : "global",
    gridKey,
    q.flags.join(","),
    q.types.join(","),
  ].join("|");
}

export function vesselsCacheKey(q: ActivityVesselsQuery): string {
  return [
    `vessels:v${ACTIVITY_RULES_VERSION}`,
    q.windows.map((w) => `${w.from}/${w.to}`).join(","),
    `${q.lat},${q.lon},${q.radiusKm}`,
    gridKey,
    q.flags.join(","),
    q.types.join(","),
  ].join("|");
}

/**
 * The lattice cell a position falls in: `floor(lon / 0.1)`, `floor(lat / 0.03)`.
 * The ClickHouse query computes the same two expressions (see
 * activity-source.ts); this is the definition the tests pin.
 */
export function activityCellIndex(lon: number, lat: number): [number, number] {
  return [
    Math.floor(lon / ACTIVITY_GRID.lonDeg),
    Math.floor(lat / ACTIVITY_GRID.latDeg),
  ];
}

/** A cell's centre, `(index + ½) · size`, rounded to 3 dp — FishFacts' `.x5` centres. */
export function activityCellCentre(ix: number, iy: number): [number, number] {
  return [
    round((ix + 0.5) * ACTIVITY_GRID.lonDeg, 3),
    round((iy + 0.5) * ACTIVITY_GRID.latDeg, 3),
  ];
}

/** One cell from ClickHouse: [ix, iy, distinct vessels, [[flag, typeId, minutes] per vessel]]. */
export type ActivityCellRow = [
  number,
  number,
  number | string,
  Array<[string, number, number | string]>,
];

export type ActivityMeta = {
  from: string;
  to: string;
  bbox: ActivityBbox | null;
  generatedAt: string;
  cached: boolean;
};

export type ActivityFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    weights: Record<string, Record<string, number>>;
    vessels: number;
  };
};

export type ActivityFeatureCollection = {
  type: "FeatureCollection";
  features: ActivityFeature[];
  meta: ActivityMeta & { grid: [number, number] };
};

export function buildActivityFeatureCollection(
  rows: ActivityCellRow[],
  meta: ActivityMeta,
): ActivityFeatureCollection {
  const features: ActivityFeature[] = [];
  for (const [ix, iy, vessels, perVessel] of rows) {
    const sums: Record<string, Record<string, number>> = {};
    for (const [flag, typeId, minutes] of perVessel) {
      const byType = sums[flag] ?? {};
      sums[flag] = byType;
      byType[String(typeId)] = (byType[String(typeId)] ?? 0) + Number(minutes);
    }
    const weights: Record<string, Record<string, number>> = {};
    for (const [flag, byType] of Object.entries(sums)) {
      for (const [typeId, minutes] of Object.entries(byType)) {
        const value = round(minutes, 2);
        if (value <= 0) continue;
        weights[flag] ??= {};
        (weights[flag] as Record<string, number>)[typeId] = value;
      }
    }
    if (Object.keys(weights).length === 0) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: activityCellCentre(ix, iy) },
      properties: { weights, vessels: Number(vessels) },
    });
  }
  return {
    type: "FeatureCollection",
    features,
    meta: {
      from: meta.from,
      to: meta.to,
      bbox: meta.bbox,
      grid: [ACTIVITY_GRID.lonDeg, ACTIVITY_GRID.latDeg],
      generatedAt: meta.generatedAt,
      cached: meta.cached,
    },
  };
}

/** One (window, vessel) answer from ClickHouse for the hover. */
export type ActivityHoverRow = {
  window: number;
  vesselId: number;
  name: string | null;
  flag: string;
  typeId: number;
  minutes: number;
};

export type ActivityHoverVessel = {
  vesselId: number;
  name: string | null;
  flag: string;
  typeId: number;
  minutes: number;
};

export type ActivityVesselsResponse = {
  vesselCount: number;
  totalMinutes: number;
  vessels: ActivityHoverVessel[];
};

/**
 * Distinct across windows (a vessel fishing the same ground in two seasons is
 * one vessel with both seasons' minutes), sorted by minutes, cut to 50 rows —
 * with `vesselCount` and `totalMinutes` over everyone, so the card never
 * under-reports because the list is short.
 */
export function mergeHoverRows(
  rows: ActivityHoverRow[],
): ActivityVesselsResponse {
  const byVessel = new Map<number, ActivityHoverVessel>();
  for (const row of rows) {
    const existing = byVessel.get(row.vesselId);
    if (existing) {
      existing.minutes += row.minutes;
      continue;
    }
    byVessel.set(row.vesselId, {
      vesselId: row.vesselId,
      name: row.name,
      flag: row.flag,
      typeId: row.typeId,
      minutes: row.minutes,
    });
  }
  const all = [...byVessel.values()].sort(
    (a, b) => b.minutes - a.minutes || a.vesselId - b.vesselId,
  );
  const totalMinutes = all.reduce((sum, v) => sum + v.minutes, 0);
  return {
    vesselCount: all.length,
    totalMinutes: round(totalMinutes, 2),
    vessels: all
      .slice(0, ACTIVITY_HOVER_MAX_ROWS)
      .map((v) => ({ ...v, minutes: round(v.minutes, 2) })),
  };
}

/**
 * The FishFacts registry's flag column → the code the FE filters on. The
 * registry stores Sweden as `SW` (no `SE` row exists), which left Sweden at 0 h
 * in the spike; every other FE flag is stored under its ISO-2 code. `char(6)`
 * pads, hence the trim.
 */
export function normaliseRegistryFlag(raw: string | null | undefined) {
  const flag = raw?.trim().toUpperCase();
  if (!flag) return null;
  return REGISTRY_FLAG_ALIASES[flag] ?? flag;
}

const REGISTRY_FLAG_ALIASES: Readonly<Record<string, string>> = { SW: "SE" };
