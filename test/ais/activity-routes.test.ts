import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import type { ActivityCellRow, ActivityHoverRow } from "../../src/ais/activity";
import {
  type ActivityCacheStore,
  ActivityResponseCache,
} from "../../src/ais/activity-cache";
import {
  classifyUpstreamError,
  createActivityRouter,
} from "../../src/ais/activity-routes";
import type {
  ActivityCellsRequest,
  ActivityDataSource,
  ActivityHoverRequest,
} from "../../src/ais/activity-source";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const SEASON =
  "/?from=2025-09-10T00:00:00Z&to=2025-10-29T00:00:00Z&bbox=-30,55,35,80";

type Calls = {
  cells: ActivityCellsRequest[];
  hover: ActivityHoverRequest[];
  ready: number;
};

function fakeSource(
  opts: {
    cells?: ActivityCellRow[];
    hover?: ActivityHoverRow[];
    ready?: boolean;
    fail?: unknown;
  } = {},
): { source: ActivityDataSource; calls: Calls } {
  const calls: Calls = { cells: [], hover: [], ready: 0 };
  return {
    calls,
    source: {
      async getActivityCells(req) {
        calls.cells.push(req);
        if (opts.fail) throw opts.fail;
        return opts.cells ?? [[-69, 2067, 2, [["FO", 3, 30]]]];
      },
      async getHoverRows(req) {
        calls.hover.push(req);
        if (opts.fail) throw opts.fail;
        return (
          opts.hover ?? [
            {
              window: 0,
              vesselId: 7,
              name: "NORDBORG",
              flag: "FO",
              typeId: 2,
              minutes: 12.5,
            },
          ]
        );
      },
      async isReady() {
        calls.ready++;
        return opts.ready ?? true;
      },
    },
  };
}

class MemoryStore implements ActivityCacheStore {
  readonly entries = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async put(key: string, gz: Uint8Array) {
    this.entries.set(key, gz);
  }
}

function makeApp(
  source: ActivityDataSource,
  store: ActivityCacheStore | null = null,
  now = () => NOW,
) {
  const cache = new ActivityResponseCache({
    store,
    memoryMaxBytes: 10_000_000,
    mutableTtlMs: 300_000,
    now,
  });
  return createActivityRouter({ source, cache, now });
}

async function errorOf(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe("GET /api/ais/activity", () => {
  test("200 GeoJSON in FishFacts' file shape, gzip when asked", async () => {
    const { source, calls } = fakeSource();
    const res = await makeApp(source).request(SEASON, {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/geo+json");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    const body = JSON.parse(
      gunzipSync(new Uint8Array(await res.arrayBuffer())).toString(),
    );
    expect(body.type).toBe("FeatureCollection");
    expect(body.features[0]).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-6.85, 62.025] },
      properties: { weights: { FO: { "3": 30 } }, vessels: 2 },
    });
    expect(body.meta).toMatchObject({
      from: "2025-09-10T00:00:00.000Z",
      to: "2025-10-29T00:00:00.000Z",
      bbox: [-30, 55, 35, 80],
      grid: [0.1, 0.03],
      cached: false,
    });
    // the source gets the normalised query
    expect(calls.cells[0]).toEqual({
      from: "2025-09-10T00:00:00.000Z",
      to: "2025-10-29T00:00:00.000Z",
      bbox: [-30, 55, 35, 80],
      flags: ["CA", "DK", "FO", "GB", "GL", "IE", "IS", "NO", "NZ", "RU", "SE"],
      types: [2, 3, 4, 5, 6, 8, 10, 28, 29],
    });
  });

  test("plain JSON when the client does not accept gzip", async () => {
    const { source } = fakeSource();
    const res = await makeApp(source).request(SEASON, {
      headers: { "Accept-Encoding": "gzip;q=0, identity" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = (await res.json()) as { features: unknown[] };
    expect(body.features).toHaveLength(1);
  });

  test("a past window is immutable; one ending within 24 h is max-age=300", async () => {
    const { source } = fakeSource();
    const app = makeApp(source);
    const past = await app.request(SEASON);
    expect(past.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const recent = await app.request(
      `/?from=2026-11-02T00:00:00Z&to=${new Date(NOW - 3_600_000).toISOString()}`,
    );
    expect(recent.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("a repeat request is served from cache with meta.cached true, without a second query", async () => {
    const { source, calls } = fakeSource();
    const app = makeApp(source);
    const first = (await (await app.request(SEASON)).json()) as {
      meta: { cached: boolean };
    };
    const second = await app.request(SEASON);
    const body = (await second.json()) as { meta: { cached: boolean } };
    expect(first.meta.cached).toBe(false);
    expect(body.meta.cached).toBe(true);
    expect(second.headers.get("x-activity-cache")).toBe("memory");
    expect(calls.cells).toHaveLength(1);
  });

  test("an immutable window built on one pod is served by another from the shared store", async () => {
    const store = new MemoryStore();
    const podA = fakeSource();
    await makeApp(podA.source, store).request(SEASON);
    const podB = fakeSource();
    const res = await makeApp(podB.source, store).request(SEASON);
    expect(res.headers.get("x-activity-cache")).toBe("store");
    expect(podB.calls.cells).toHaveLength(0);
    expect(store.entries.size).toBe(1);
  });

  test("a recent window is never written to the shared store", async () => {
    const store = new MemoryStore();
    const { source } = fakeSource();
    await makeApp(source, store).request(
      `/?from=2026-11-02T00:00:00Z&to=${new Date(NOW - 3_600_000).toISOString()}`,
    );
    expect(store.entries.size).toBe(0);
  });

  test("concurrent identical requests share one build", async () => {
    const { source, calls } = fakeSource();
    const app = makeApp(source);
    const results = await Promise.all([
      app.request(SEASON),
      app.request(SEASON),
      app.request(SEASON),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls.cells).toHaveLength(1);
  });

  test.each([
    ["missing to", "/?from=2025-09-10T00:00:00Z", 400, "bad_request"],
    [
      "unknown flag",
      "/?from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&flags=US",
      400,
      "bad_request",
    ],
    [
      "over 92 days",
      "/?from=2025-06-01T00:00:00Z&to=2025-10-01T00:00:00Z&bbox=-30,55,35,80",
      422,
      "window_too_long",
    ],
    [
      "over 31 days global",
      "/?from=2025-09-10T00:00:00Z&to=2025-10-29T00:00:00Z",
      422,
      "global_window_too_long",
    ],
  ])("%s → %d %s, nothing queried", async (_n, url, status, code) => {
    const { source, calls } = fakeSource();
    const res = await makeApp(source).request(url);
    const { status: got, body } = await errorOf(res);
    expect(got).toBe(status);
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe("string");
    expect(calls.cells).toHaveLength(0);
  });

  test("a source that is not ready → 503 upstream_unavailable, and nothing is cached", async () => {
    const store = new MemoryStore();
    const { source, calls } = fakeSource({ ready: false });
    const res = await makeApp(source, store).request(SEASON);
    const { status, body } = await errorOf(res);
    expect(status).toBe(503);
    expect(body.code).toBe("upstream_unavailable");
    expect(calls.cells).toHaveLength(0);
    expect(store.entries.size).toBe(0);
  });

  test("a ClickHouse timeout → 504 upstream_timeout, and the next request retries", async () => {
    const timeout = Object.assign(
      new Error("Timeout exceeded: elapsed 30.1 seconds"),
      {
        code: "159",
        type: "TIMEOUT_EXCEEDED",
      },
    );
    const { source, calls } = fakeSource({ fail: timeout });
    const app = makeApp(source);
    const { status, body } = await errorOf(await app.request(SEASON));
    expect(status).toBe(504);
    expect(body.code).toBe("upstream_timeout");
    await app.request(SEASON);
    expect(calls.cells).toHaveLength(2);
  });

  test("connection refused → 503 upstream_unavailable", async () => {
    const { source } = fakeSource({
      fail: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8123"), {
        code: "ECONNREFUSED",
      }),
    });
    const { status, body } = await errorOf(
      await makeApp(source).request(SEASON),
    );
    expect(status).toBe(503);
    expect(body.code).toBe("upstream_unavailable");
  });

  test("an unrecognised failure is not dressed up as an upstream outage", async () => {
    const { source } = fakeSource({
      fail: new Error("synthetic test error: not an upstream failure"),
    });
    // Thrown on to the app's onError (500), never mapped to 503/504.
    const res = await makeApp(source).request(SEASON);
    expect(res.status).toBe(500);
  });
});

describe("GET /api/ais/activity/vessels", () => {
  const HOVER =
    "/vessels?windows=2025-09-10T00:00:00Z/2025-10-29T00:00:00Z,2024-09-10T00:00:00Z/2024-10-29T00:00:00Z&lat=62.2351&lon=-4.25&radiusKm=15";

  test("200 with the contract shape; the source gets rounded, sorted inputs", async () => {
    const { source, calls } = fakeSource({
      hover: [
        {
          window: 0,
          vesselId: 1,
          name: "A",
          flag: "FO",
          typeId: 2,
          minutes: 10,
        },
        {
          window: 1,
          vesselId: 1,
          name: "A",
          flag: "FO",
          typeId: 2,
          minutes: 5,
        },
        {
          window: 1,
          vesselId: 2,
          name: null,
          flag: "NO",
          typeId: 3,
          minutes: 20,
        },
      ],
    });
    const res = await makeApp(source).request(HOVER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.json()).toEqual({
      vesselCount: 2,
      totalMinutes: 35,
      vessels: [
        { vesselId: 2, name: null, flag: "NO", typeId: 3, minutes: 20 },
        { vesselId: 1, name: "A", flag: "FO", typeId: 2, minutes: 15 },
      ],
    });
    expect(calls.hover[0]).toMatchObject({
      windows: [
        { from: "2024-09-10T00:00:00.000Z", to: "2024-10-29T00:00:00.000Z" },
        { from: "2025-09-10T00:00:00.000Z", to: "2025-10-29T00:00:00.000Z" },
      ],
      lat: 62.235,
      lon: -4.25,
      radiusKm: 15,
    });
  });

  test("a window still within the last day makes the answer max-age=300", async () => {
    const { source } = fakeSource();
    const res = await makeApp(source).request(
      `/vessels?windows=2026-11-01T00:00:00Z/${new Date(NOW - 60_000).toISOString()}&lat=62&lon=-7&radiusKm=10`,
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test.each([
    ["no windows", "/vessels?lat=62&lon=-7&radiusKm=10", 400, "bad_request"],
    [
      "radius 0",
      "/vessels?windows=2025-09-10T00:00:00Z/2025-10-29T00:00:00Z&lat=62&lon=-7&radiusKm=0",
      400,
      "bad_request",
    ],
    [
      "window over 92 days",
      "/vessels?windows=2025-01-01T00:00:00Z/2025-06-01T00:00:00Z&lat=62&lon=-7&radiusKm=10",
      422,
      "window_too_long",
    ],
  ])("%s → %d %s", async (_n, url, status, code) => {
    const { source, calls } = fakeSource();
    const { status: got, body } = await errorOf(
      await makeApp(source).request(url),
    );
    expect(got).toBe(status);
    expect(body.code).toBe(code);
    expect(calls.hover).toHaveLength(0);
  });

  test("a ClickHouse timeout → 504 upstream_timeout", async () => {
    const { source } = fakeSource({ fail: new Error("Timeout error.") });
    const { status, body } = await errorOf(
      await makeApp(source).request(HOVER),
    );
    expect(status).toBe(504);
    expect(body.code).toBe("upstream_timeout");
  });
});

describe("classifyUpstreamError", () => {
  test("knows timeouts and outages, and nothing else", () => {
    expect(classifyUpstreamError({ code: "159" })?.code).toBe(
      "upstream_timeout",
    );
    expect(classifyUpstreamError(new Error("socket hang up"))?.code).toBe(
      "upstream_unavailable",
    );
    expect(classifyUpstreamError(new Error("Unknown column"))).toBeNull();
  });
});
