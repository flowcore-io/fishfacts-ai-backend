import { Hono } from "hono";
import type { AisClickhouseRepository } from "./clickhouse-repository";

export type AisRouterDeps = {
  repository: AisClickhouseRepository;
};

const MAX_VESSELS = 50;
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

  return app;
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

function parseRange(
  params: URLSearchParams,
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

  // Default: last 24h.
  const to = new Date();
  return {
    from: new Date(to.getTime() - WINDOWS["24h"]).toISOString(),
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
