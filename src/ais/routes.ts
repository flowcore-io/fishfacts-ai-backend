import { type Context, Hono } from "hono";
import type { AisClickhouseRepository } from "./clickhouse-repository";

export type AisRouterDeps = {
  repository: AisClickhouseRepository;
};

const MAX_VESSELS = 50;
// Density gear-filter id lists come from the FE resolving a vessel type to its
// fleet (e.g. all longliners), so the cap is far higher than /tracks' 50.
const MAX_DENSITY_VESSELS = 5000;
const DEFAULT_MAX_POINTS = 2000;
const MAX_MAX_POINTS = 50_000;

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
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        { error: "invalid_query", message: "body must be JSON" } as QueryError,
        400,
      );
    }
    return runDensity(c, deps, bodyToParams(body), body.vesselIds ?? null);
  });

  return app;
}

async function runDensity(
  c: Context,
  deps: AisRouterDeps,
  params: URLSearchParams,
  vesselIdsRaw: unknown,
): Promise<Response> {
  const bbox = parseBbox(params.get("bbox"));
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
    limit: parseLimitCells(params.get("limit")),
  });
  return c.json(result);
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
