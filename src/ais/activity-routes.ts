/**
 * `GET /api/ais/activity` and `GET /api/ais/activity/vessels` — the Fishing
 * Activity layer for windows FishFacts' own rolling files do not cover (past
 * seasons, 2021 onwards). Parameters, limits and error codes are fixed by the
 * contract agreed with fishfacts-fe; see activity.ts.
 */
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { type Context, Hono } from "hono";
import {
  type ActivityError,
  type ActivityQuery,
  type ActivityVesselsQuery,
  activityCacheKey,
  buildActivityFeatureCollection,
  isImmutableWindow,
  mergeHoverRows,
  parseActivityQuery,
  parseActivityVesselsQuery,
  vesselsCacheKey,
} from "./activity";
import type { ActivityResponseCache, BuiltBodies } from "./activity-cache";
import type { ActivityDataSource } from "./activity-source";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MUTABLE_CACHE_CONTROL = "public, max-age=300";
/** How long a "the source is ready" answer is trusted before asking again. */
const READY_CHECK_TTL_MS = 60_000;
/**
 * Cold builds running at once in one pod. A 30-day global window holds ~30 MB
 * of JSON while it is serialised; a pre-warm loop must queue, not stack.
 */
const DEFAULT_MAX_CONCURRENT_BUILDS = 2;

export type ActivityRouterDeps = {
  source: ActivityDataSource;
  cache: ActivityResponseCache;
  now?: () => number;
  maxConcurrentBuilds?: number;
};

/** A failure the contract has a code for, thrown out of a cache build. */
class ActivityFailure extends Error {
  constructor(readonly failure: ActivityError) {
    super(failure.error);
  }
}

/**
 * ClickHouse/MySQL trouble → contract §3. Anything not recognisable as an
 * upstream timeout or outage returns null and stays a 500: a bug in our SQL
 * must not read as "History is unavailable right now".
 */
export function classifyUpstreamError(error: unknown): ActivityError | null {
  const e = (error ?? {}) as { code?: unknown; type?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  if (
    e.code === "159" ||
    e.type === "TIMEOUT_EXCEEDED" ||
    /timeout/i.test(message)
  ) {
    return {
      status: 504,
      code: "upstream_timeout",
      error: "History is taking too long. Try a shorter period.",
    };
  }
  const netCodes = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ETIMEDOUT",
  ];
  if (
    (typeof e.code === "string" && netCodes.includes(e.code)) ||
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|socket hang up|fetch failed|unable to connect/i.test(
      message,
    )
  ) {
    return {
      status: 503,
      code: "upstream_unavailable",
      error: "History is unavailable right now.",
    };
  }
  return null;
}

function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

/** A tiny FIFO semaphore. */
function createLimiter(max: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((r) => queue.push(r));
    running++;
    try {
      return await task();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

export function createActivityRouter(deps: ActivityRouterDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const limit = createLimiter(
    deps.maxConcurrentBuilds ?? DEFAULT_MAX_CONCURRENT_BUILDS,
  );
  let readyUntil = 0;

  /**
   * A source that cannot answer yet (ours: no registry snapshot) would answer
   * empty. Refuse (503, never cached) rather than cache an empty season as
   * immutable truth.
   */
  async function requireReady(): Promise<void> {
    if (now() < readyUntil) return;
    if (!(await deps.source.isReady())) {
      throw new ActivityFailure({
        status: 503,
        code: "upstream_unavailable",
        error: "History is unavailable right now.",
      });
    }
    readyUntil = now() + READY_CHECK_TTL_MS;
  }

  async function respond(
    c: Context,
    opts: {
      key: string;
      immutable: boolean;
      contentType: string;
      build: () => Promise<BuiltBodies>;
    },
  ): Promise<Response> {
    let result: Awaited<ReturnType<ActivityResponseCache["get"]>>;
    try {
      result = await deps.cache.get(opts.key, opts.immutable, () =>
        limit(async () => {
          await requireReady();
          return opts.build();
        }),
      );
    } catch (error) {
      const failure =
        error instanceof ActivityFailure
          ? error.failure
          : classifyUpstreamError(error);
      if (!failure) throw error;
      console.error("[AIS] activity upstream failure", {
        code: failure.code,
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: failure.error, code: failure.code },
        failure.status,
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": opts.contentType,
      "Cache-Control": opts.immutable
        ? IMMUTABLE_CACHE_CONTROL
        : MUTABLE_CACHE_CONTROL,
      Vary: "Accept-Encoding",
      "X-Activity-Cache": result.source,
    };
    if (acceptsGzip(c.req.header("accept-encoding"))) {
      headers["Content-Encoding"] = "gzip";
      return c.body(result.gz as Uint8Array<ArrayBuffer>, 200, headers);
    }
    const plain = await gunzipAsync(result.gz);
    return c.body(plain as Uint8Array<ArrayBuffer>, 200, headers);
  }

  function badParams(c: Context, failure: ActivityError): Response {
    return c.json({ error: failure.error, code: failure.code }, failure.status);
  }

  app.get("/", async (c) => {
    const nowMs = now();
    const q = parseActivityQuery(new URL(c.req.url).searchParams, nowMs);
    if ("code" in q) return badParams(c, q);
    return respond(c, {
      key: activityCacheKey(q),
      immutable: isImmutableWindow(q.toMs, nowMs),
      contentType: "application/geo+json",
      build: () => buildHeatmap(deps, q, now),
    });
  });

  app.get("/vessels", async (c) => {
    const nowMs = now();
    const q = parseActivityVesselsQuery(new URL(c.req.url).searchParams, nowMs);
    if ("code" in q) return badParams(c, q);
    return respond(c, {
      key: vesselsCacheKey(q),
      immutable: q.windows.every((w) =>
        isImmutableWindow(Date.parse(w.to), nowMs),
      ),
      contentType: "application/json",
      build: () => buildHover(deps, q),
    });
  });

  return app;
}

/** `"cached":false}}` closes every heatmap body: meta is the last key, cached its last. */
const FRESH_SUFFIX = '"cached":false}}';
const STORED_SUFFIX = '"cached":true}}';

async function buildHeatmap(
  deps: ActivityRouterDeps,
  q: ActivityQuery,
  now: () => number,
): Promise<BuiltBodies> {
  const rows = await deps.source.getActivityCells({
    from: q.from,
    to: q.to,
    bbox: q.bbox,
    flags: q.flags,
    types: q.types,
  });
  const fresh = JSON.stringify(
    buildActivityFeatureCollection(rows, {
      from: q.from,
      to: q.to,
      bbox: q.bbox,
      generatedAt: new Date(now()).toISOString(),
      cached: false,
    }),
  );
  if (!fresh.endsWith(FRESH_SUFFIX)) {
    throw new Error("activity body does not end with meta.cached");
  }
  // The copy later readers get says it came from the cache. Swapping the tail
  // costs one string copy; re-serialising 30 MB of features would cost more.
  const stored = `${fresh.slice(0, -FRESH_SUFFIX.length)}${STORED_SUFFIX}`;
  const [freshGz, storedGz] = await Promise.all([
    gzipAsync(fresh),
    gzipAsync(stored),
  ]);
  return { fresh: freshGz, stored: storedGz };
}

async function buildHover(
  deps: ActivityRouterDeps,
  q: ActivityVesselsQuery,
): Promise<BuiltBodies> {
  const rows = await deps.source.getHoverRows({
    windows: q.windows,
    lat: q.lat,
    lon: q.lon,
    radiusKm: q.radiusKm,
    flags: q.flags,
    types: q.types,
  });
  const gz = await gzipAsync(JSON.stringify(mergeHoverRows(rows)));
  return { fresh: gz, stored: gz };
}
