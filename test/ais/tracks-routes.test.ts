import { describe, expect, test } from "bun:test";
import type { AisClickhouseRepository } from "../../src/ais/clickhouse-repository";
import { createAisRouter } from "../../src/ais/routes";

type Captured = { opts?: Record<string, unknown> };

function mockRepo(captured: Captured): AisClickhouseRepository {
  return {
    getTracks: async (opts: Record<string, unknown>) => {
      captured.opts = opts;
      return {
        from: opts.from as string,
        to: opts.to as string,
        vessels: (opts.vesselIds as number[]).map((id) => ({
          vesselId: id,
          pointCount: 0,
          last: null,
          points: [],
        })),
      };
    },
  } as unknown as AisClickhouseRepository;
}

async function postTracks(
  app: ReturnType<typeof createAisRouter>,
  body: unknown,
): Promise<Response> {
  return await app.request("/tracks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A simple closed square around the Faroe Bank, [lng,lat].
const SQUARE = [
  [-9, 60.5],
  [-8, 60.5],
  [-8, 61.2],
  [-9, 61.2],
  [-9, 60.5],
];

describe("POST /tracks — validation", () => {
  test("400 on non-JSON body", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await app.request("/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("400 when vesselIds missing", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postTracks(app, { window: "24h" });
    expect(res.status).toBe(400);
  });

  test("400 on an invalid vesselId", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postTracks(app, { vesselIds: [12, "abc"] });
    expect(res.status).toBe(400);
  });

  test("400 on too many vessels (>50)", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postTracks(app, {
      vesselIds: Array.from({ length: 51 }, (_, i) => i + 1),
    });
    expect(res.status).toBe(400);
  });

  test("400 on an unknown window", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postTracks(app, { vesselIds: [1], window: "13d" });
    expect(res.status).toBe(400);
  });

  test("400 on a bad speed band (max < min)", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postTracks(app, {
      vesselIds: [1],
      minKnots: 5,
      maxKnots: 1,
    });
    expect(res.status).toBe(400);
  });

  test("400 on a malformed polygon", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postTracks(app, {
      vesselIds: [1],
      polygon: { type: "LineString", coordinates: SQUARE },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /tracks — parsing", () => {
  test("polygon reaches getTracks as one ring", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postTracks(app, {
      vesselIds: [42],
      polygon: { type: "Polygon", coordinates: [SQUARE] },
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect((o.polygons as unknown[]).length).toBe(1);
    expect(o.vesselIds).toEqual([42]);
  });

  test("unclosed polygon ring is auto-closed", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const open = SQUARE.slice(0, 4);
    const res = await postTracks(app, {
      vesselIds: [1],
      polygon: { type: "Polygon", coordinates: [open] },
    });
    expect(res.status).toBe(200);
    const rings = (captured.opts as { polygons: number[][][] }).polygons;
    expect(rings[0]?.at(0)).toEqual(rings[0]?.at(-1) as number[]);
  });

  test("speed band passes through to the repo", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postTracks(app, {
      vesselIds: [1],
      minKnots: 0.3,
      maxKnots: 5.5,
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, number>;
    expect(o.minKnots).toBe(0.3);
    expect(o.maxKnots).toBe(5.5);
  });

  test("no polygon / no speed band ⇒ undefined (GET /tracks behaviour)", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postTracks(app, { vesselIds: [1], window: "24h" });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.polygons).toBeUndefined();
    expect(o.minKnots).toBeUndefined();
    expect(o.maxKnots).toBeUndefined();
  });

  test("maxPointsPerVessel and status are forwarded", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postTracks(app, {
      vesselIds: [1],
      maxPointsPerVessel: 8000,
      status: "under way using engine",
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.maxPointsPerVessel).toBe(8000);
    expect(o.statuses).toEqual(["under way using engine"]);
  });

  test("vesselIds accepts a comma-separated string too", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postTracks(app, { vesselIds: "7,8,9" });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.vesselIds).toEqual([7, 8, 9]);
  });

  test("from/to range is forwarded verbatim", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postTracks(app, {
      vesselIds: [1],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, string>;
    expect(o.from).toBe("2026-01-01T00:00:00.000Z");
    expect(o.to).toBe("2026-07-02T00:00:00.000Z");
  });
});
