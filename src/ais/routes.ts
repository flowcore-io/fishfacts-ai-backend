import { type Context, Hono } from "hono";
import type { AisClickhouseRepository } from "./clickhouse-repository";
import {
  AIS_FISHING_MAX_KNOTS,
  AIS_FISHING_MIN_KNOTS,
  AIS_RUN_MAX_GAP_MINUTES,
} from "./fishing-runs";

export type AisRouterDeps = {
  repository: AisClickhouseRepository;
};

const MAX_VESSELS = 50;
// Density gear-filter id lists come from the FE resolving a vessel type to its
// fleet (e.g. all longliners), so the cap is far higher than /tracks' 50.
const MAX_DENSITY_VESSELS = 5000;
const DEFAULT_MAX_POINTS = 2000;
const MAX_MAX_POINTS = 50_000;
const MAX_EFFORT_POLYGONS = 10;
const MAX_EFFORT_VERTICES = 1000;
// "Fishing" for effort analytics: trawling/hauling speeds. Wider than the map
// UI's visual Activity-layer band (1–5.5) by design — client-specified. Read
// from ais/fishing-runs.ts rather than restated here, so effort and the
// Sildelaget derived catch positions can never answer different questions.
const DEFAULT_EFFORT_MIN_KNOTS = AIS_FISHING_MIN_KNOTS;
const DEFAULT_EFFORT_MAX_KNOTS = AIS_FISHING_MAX_KNOTS;
const DEFAULT_MAX_GAP_MINUTES = AIS_RUN_MAX_GAP_MINUTES;
const MAX_EFFORT_VESSEL_ROWS = 500;

// Preset windows mirror the map UI (6h … 90d). Value = milliseconds back from now.
const WINDOWS: Record<string, number> = {
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "3d": 3 * 86_400_000,
  "7d": 7 * 86_400_000,
  "14d": 14 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

type QueryError = { error: "invalid_query"; message: string };

export function createAisRouter(deps: AisRouterDeps): Hono {
  const app = new Hono();

  app.get("/tracks", async (c) => {
    const params = new URL(c.req.url).searchParams;

    const vesselIds = parseVesselIds(params.get("vesselIds"));
    if ("error" in vesselIds) return c.json(vesselIds, 400);

    const range = parseRange(params);
    if ("error" in range) return c.json(range, 400);

    const result = await deps.repository.getTracks({
      vesselIds: vesselIds.ids,
      from: range.from,
      to: range.to,
      maxPointsPerVessel: parseMaxPoints(params.get("maxPointsPerVessel")),
      statuses: parseStatuses(params.get("status")),
    });
    return c.json(result);
  });

  // Same as GET /tracks but accepts a GeoJSON `polygon` (Polygon/MultiPolygon)
  // that clips each vessel's track to the drawn area, plus an optional
  // minKnots/maxKnots speed band. POST-only: a polygon doesn't fit in a GET URL
  // (same reason as /density and /effort). Without a polygon this behaves like
  // GET /tracks — the clip/speed filters only narrow the fixes, never widen.
  app.post("/tracks", async (c) => {
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;

    const vesselIds = parseVesselIds(
      Array.isArray(body.vesselIds)
        ? (body.vesselIds as unknown[]).join(",")
        : ((body.vesselIds as string | null | undefined) ?? null),
    );
    if ("error" in vesselIds) return c.json(vesselIds, 400);

    const params = bodyToParams(body);

    const range = parseRange(params);
    if ("error" in range) return c.json(range, 400);

    const speed = parseSpeed(params);
    if ("error" in speed) return c.json(speed, 400);

    const polygons = parseEffortPolygon(body.polygon);
    if (polygons && "error" in polygons) return c.json(polygons, 400);

    const result = await deps.repository.getTracks({
      vesselIds: vesselIds.ids,
      from: range.from,
      to: range.to,
      maxPointsPerVessel: parseMaxPoints(params.get("maxPointsPerVessel")),
      statuses: parseStatuses(params.get("status")),
      minKnots: speed.minKnots,
      maxKnots: speed.maxKnots,
      polygons: polygons?.rings,
    });
    return c.json(result);
  });

  // Fleet-density grid over a bbox + window — the "where is the fleet (fishing)"
  // signal for area recommendations and custom AIS heatmaps. Optional speed band
  // restricts to fishing speeds; optional vesselIds restrict to a gear/vessel
  // type (resolved by the FE). Defaults to the last 7d when no window/from/to is
  // given. Available as GET (query params) or POST (JSON body) — a gear-filtered
  // vesselIds list can be large enough to overflow a GET URL.
  app.get("/density", async (c) => {
    const params = new URL(c.req.url).searchParams;
    return runDensity(c, deps, params, params.get("vesselIds"));
  });

  app.post("/density", async (c) => {
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const polygons = parseEffortPolygon(body.polygon);
    if (polygons && "error" in polygons) return c.json(polygons, 400);
    return runDensity(
      c,
      deps,
      bodyToParams(body),
      body.vesselIds ?? null,
      polygons?.rings,
    );
  });

  // Per-vessel fishing-effort aggregation inside a polygon/bbox + time range.
  // "Fishing" = fixes in the speed band (default 0.3–5.5 kn). Effort duration
  // = per-vessel sum of gaps between consecutive qualifying fixes, discarding
  // gaps above maxGapMinutes (default 30) so AIS coverage holes are never
  // credited as fishing. POST-only: polygons don't fit in GET query params.
  app.post("/effort", async (c) => {
    const body = await readJsonBody(c);
    if (body instanceof Response) return body;
    const params = bodyToParams(body);

    const polygons = parseEffortPolygon(body.polygon);
    if (polygons && "error" in polygons) return c.json(polygons, 400);

    let bbox: ReturnType<typeof parseBbox> | undefined;
    if (params.get("bbox") != null) {
      bbox = parseBbox(params.get("bbox"));
      if ("error" in bbox) return c.json(bbox, 400);
    } else if (polygons) {
      bbox = bboxOfRings(polygons.rings);
    }
    if (!bbox || "error" in bbox) {
      return c.json(
        {
          error: "invalid_query",
          message: "polygon or bbox is required",
        } as QueryError,
        400,
      );
    }

    const range = parseRange(params, "7d");
    if ("error" in range) return c.json(range, 400);

    const speed = parseSpeed(params);
    if ("error" in speed) return c.json(speed, 400);

    const vessels = parseDensityVesselIds(body.vesselIds ?? null);
    if ("error" in vessels) return c.json(vessels, 400);

    const result = await deps.repository.getFishingEffort({
      ...bbox,
      polygons: polygons?.rings,
      from: range.from,
      to: range.to,
      minKnots: speed.minKnots ?? DEFAULT_EFFORT_MIN_KNOTS,
      maxKnots: speed.maxKnots ?? DEFAULT_EFFORT_MAX_KNOTS,
      maxGapSeconds: parseMaxGapMinutes(body.maxGapMinutes) * 60,
      vesselIds: vessels.ids,
      limit: parseEffortLimit(body.limit),
    });
    return c.json(result);
  });

  return app;
}

// Parse a JSON request body, or return a 400 Response the caller should
// forward. Shared by the three POST handlers (/tracks, /density, /effort).
async function readJsonBody(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      { error: "invalid_query", message: "body must be JSON" } as QueryError,
      400,
    );
  }
}

async function runDensity(
  c: Context,
  deps: AisRouterDeps,
  params: URLSearchParams,
  vesselIdsRaw: unknown,
  polygons?: number[][][],
): Promise<Response> {
  const bbox =
    params.get("bbox") == null && polygons?.length
      ? bboxOfRings(polygons)
      : parseBbox(params.get("bbox"));
  if ("error" in bbox) return c.json(bbox, 400);

  const range = parseRange(params, "7d");
  if ("error" in range) return c.json(range, 400);

  const speed = parseSpeed(params);
  if ("error" in speed) return c.json(speed, 400);

  const vessels = parseDensityVesselIds(vesselIdsRaw);
  if ("error" in vessels) return c.json(vessels, 400);

  const result = await deps.repository.getDensityGrid({
    ...bbox,
    gridDeg: parseGrid(params.get("gridDeg")),
    from: range.from,
    to: range.to,
    ...speed,
    vesselIds: vessels.ids,
    polygons,
    limit: parseLimitCells(params.get("limit")),
  });
  return c.json(result);
}

/**
 * Optional GeoJSON Polygon/MultiPolygon → outer rings ([lng,lat], closed).
 * Holes (rings beyond the first) are ignored — drawn map areas never carry
 * them. Rings are auto-closed; caps keep the ClickHouse pointInPolygon
 * OR-chain bounded.
 */
function parseEffortPolygon(
  raw: unknown,
): { rings: number[][][] } | QueryError | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      error: "invalid_query",
      message: "polygon must be a GeoJSON Polygon or MultiPolygon object",
    };
  }
  const geo = raw as { type?: unknown; coordinates?: unknown };
  let outers: unknown[];
  if (geo.type === "Polygon") {
    outers = [(geo.coordinates as unknown[])?.[0]];
  } else if (geo.type === "MultiPolygon") {
    outers = ((geo.coordinates as unknown[]) ?? []).map(
      (poly) => (poly as unknown[])?.[0],
    );
  } else {
    return {
      error: "invalid_query",
      message: "polygon.type must be Polygon or MultiPolygon",
    };
  }
  if (outers.length === 0 || outers.some((r) => !Array.isArray(r))) {
    return { error: "invalid_query", message: "polygon has no valid rings" };
  }
  if (outers.length > MAX_EFFORT_POLYGONS) {
    return {
      error: "invalid_query",
      message: `too many polygons: max ${MAX_EFFORT_POLYGONS}`,
    };
  }
  const rings: number[][][] = [];
  let totalVertices = 0;
  for (const outer of outers as unknown[][]) {
    const ring: number[][] = [];
    for (const vertex of outer) {
      if (
        !Array.isArray(vertex) ||
        vertex.length < 2 ||
        !Number.isFinite(vertex[0]) ||
        !Number.isFinite(vertex[1]) ||
        (vertex[0] as number) < -180 ||
        (vertex[0] as number) > 180 ||
        (vertex[1] as number) < -90 ||
        (vertex[1] as number) > 90
      ) {
        return {
          error: "invalid_query",
          message: "polygon vertices must be [lng,lat] pairs in WGS84 range",
        };
      }
      ring.push([vertex[0] as number, vertex[1] as number]);
    }
    const first = ring[0];
    const last = ring.at(-1);
    const isClosed =
      first && last && first[0] === last[0] && first[1] === last[1];
    if (ring.length < (isClosed ? 4 : 3)) {
      return {
        error: "invalid_query",
        message: "each polygon ring needs at least 3 distinct vertices",
      };
    }
    if (!isClosed && first) ring.push([first[0], first[1]]);
    totalVertices += ring.length;
    rings.push(ring);
  }
  if (totalVertices > MAX_EFFORT_VERTICES) {
    return {
      error: "invalid_query",
      message: `too many polygon vertices: max ${MAX_EFFORT_VERTICES} total (simplify the geometry)`,
    };
  }
  return { rings };
}

function parseMaxGapMinutes(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (raw == null || !Number.isFinite(n)) return DEFAULT_MAX_GAP_MINUTES;
  return Math.min(Math.max(n, 1), 120);
}

function parseEffortLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (raw == null || !Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 1), MAX_EFFORT_VESSEL_ROWS);
}

function bboxOfRings(rings: number[][][]): {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
} {
  let minLon = 180;
  let minLat = 90;
  let maxLon = -180;
  let maxLat = -90;
  for (const ring of rings) {
    for (const [lng, lat] of ring as [number, number][]) {
      if (lng < minLon) minLon = lng;
      if (lng > maxLon) maxLon = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

// Normalise a JSON body into the URLSearchParams shape the parse* helpers expect.
// bbox may be a "minLon,minLat,maxLon,maxLat" string or a 4-number array.
function bodyToParams(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) params.set(key, value.join(","));
    else params.set(key, String(value));
  };
  set("bbox", body.bbox);
  set("window", body.window);
  set("from", body.from);
  set("to", body.to);
  set("gridDeg", body.gridDeg);
  set("minKnots", body.minKnots);
  set("maxKnots", body.maxKnots);
  set("limit", body.limit);
  set("maxPointsPerVessel", body.maxPointsPerVessel);
  set("status", body.status);
  return params;
}

function parseBbox(
  raw: string | null,
):
  | { minLon: number; minLat: number; maxLon: number; maxLat: number }
  | QueryError {
  if (!raw) {
    return {
      error: "invalid_query",
      message: "bbox is required: minLon,minLat,maxLon,maxLat",
    };
  }
  const p = raw.split(",").map((s) => Number.parseFloat(s.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    return {
      error: "invalid_query",
      message: "bbox must be 4 finite numbers: minLon,minLat,maxLon,maxLat",
    };
  }
  const [minLon, minLat, maxLon, maxLat] = p as [
    number,
    number,
    number,
    number,
  ];
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    return {
      error: "invalid_query",
      message: "bbox out of range or min >= max",
    };
  }
  return { minLon, minLat, maxLon, maxLat };
}

function parseGrid(raw: string | null): number {
  const n = raw ? Number.parseFloat(raw) : 0.1;
  if (!Number.isFinite(n)) return 0.1;
  return Math.min(Math.max(n, 0.02), 1);
}

function parseSpeed(
  params: URLSearchParams,
): { minKnots?: number; maxKnots?: number } | QueryError {
  const minR = params.get("minKnots");
  const maxR = params.get("maxKnots");
  if (minR == null && maxR == null) return {};
  const min = minR != null ? Number.parseFloat(minR) : 0;
  const max = maxR != null ? Number.parseFloat(maxR) : 1000;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    return {
      error: "invalid_query",
      message:
        "minKnots/maxKnots must be finite with 0 <= minKnots <= maxKnots",
    };
  }
  return { minKnots: min, maxKnots: max };
}

function parseLimitCells(raw: string | null): number {
  if (!raw) return 2000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 2000;
  return Math.min(Math.max(n, 1), 10_000);
}

function parseVesselIds(raw: string | null): { ids: number[] } | QueryError {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return {
      error: "invalid_query",
      message: "vesselIds is required: comma-separated integer vessel ids",
    };
  }
  const ids: number[] = [];
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "invalid_query", message: `invalid vesselId: ${part}` };
    }
    if (!ids.includes(n)) ids.push(n);
  }
  if (ids.length > MAX_VESSELS) {
    return {
      error: "invalid_query",
      message: `too many vessels: max ${MAX_VESSELS}`,
    };
  }
  return { ids };
}

// Optional gear/vessel-type filter for /density. Accepts a comma-separated
// string (GET) or an array (POST body). Empty/absent ⇒ no filter (all vessels).
function parseDensityVesselIds(
  raw: unknown,
): { ids: number[] | undefined } | QueryError {
  if (raw == null) return { ids: undefined };
  let parts: unknown[];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === "string") {
    parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return {
      error: "invalid_query",
      message: "vesselIds must be a comma-separated string or an array",
    };
  }
  if (parts.length === 0) return { ids: undefined };
  const ids: number[] = [];
  for (const part of parts) {
    const n =
      typeof part === "number" ? part : Number.parseInt(String(part), 10);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "invalid_query", message: `invalid vesselId: ${part}` };
    }
    if (!ids.includes(n)) ids.push(n);
  }
  if (ids.length > MAX_DENSITY_VESSELS) {
    return {
      error: "invalid_query",
      message: `too many vesselIds: max ${MAX_DENSITY_VESSELS}`,
    };
  }
  return { ids };
}

function parseRange(
  params: URLSearchParams,
  defaultWindow: keyof typeof WINDOWS = "24h",
): { from: string; to: string } | QueryError {
  const window = params.get("window")?.trim();
  if (window) {
    const ms = WINDOWS[window];
    if (!ms) {
      return {
        error: "invalid_query",
        message: `window must be one of: ${Object.keys(WINDOWS).join(", ")}`,
      };
    }
    const to = new Date();
    return {
      from: new Date(to.getTime() - ms).toISOString(),
      to: to.toISOString(),
    };
  }

  const fromRaw = params.get("from")?.trim();
  const toRaw = params.get("to")?.trim();
  if (fromRaw || toRaw) {
    if (!fromRaw || !toRaw) {
      return {
        error: "invalid_query",
        message: "from and to must both be provided (or use window)",
      };
    }
    const from = Date.parse(fromRaw);
    const to = Date.parse(toRaw);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return {
        error: "invalid_query",
        message: "from/to must be ISO-8601 datetimes",
      };
    }
    if (from >= to) {
      return { error: "invalid_query", message: "from must be before to" };
    }
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    };
  }

  // Default window (24h for tracks, 7d for density).
  const to = new Date();
  return {
    from: new Date(to.getTime() - WINDOWS[defaultWindow]).toISOString(),
    to: to.toISOString(),
  };
}

function parseMaxPoints(raw: string | null): number {
  if (!raw) return DEFAULT_MAX_POINTS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_POINTS;
  return Math.min(Math.max(n, 1), MAX_MAX_POINTS);
}

function parseStatuses(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}
