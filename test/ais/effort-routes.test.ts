import { describe, expect, test } from "bun:test";
import type { AisClickhouseRepository } from "../../src/ais/clickhouse-repository";
import { createAisRouter } from "../../src/ais/routes";

type Captured = { opts?: Record<string, unknown> };

function mockRepo(captured: Captured): AisClickhouseRepository {
  return {
    getFishingEffort: async (opts: Record<string, unknown>) => {
      captured.opts = opts;
      return {
        from: opts.from,
        to: opts.to,
        speedBand: [opts.minKnots, opts.maxKnots],
        maxGapMinutes: (opts.maxGapSeconds as number) / 60,
        bbox: [opts.minLon, opts.minLat, opts.maxLon, opts.maxLat],
        polygonCount: (opts.polygons as unknown[])?.length ?? 0,
        vesselIdCount: (opts.vesselIds as unknown[])?.length ?? 0,
        totals: {
          vessels: 1,
          fixes: 10,
          fishingSeconds: 3600,
          fishingHours: 1,
          fishingDays: 1 / 24,
        },
        vessels: [
          {
            vesselId: 42,
            fixes: 10,
            fishingSeconds: 3600,
            fishingHours: 1,
            fishingDays: 1 / 24,
            activeDays: 2,
            firstSeen: "2026-01-01T00:00:00.000Z",
            lastSeen: "2026-01-02T00:00:00.000Z",
          },
        ],
        truncated: false,
      };
    },
    getDensityGrid: async (opts: Record<string, unknown>) => {
      captured.opts = opts;
      return {
        gridDeg: opts.gridDeg,
        from: opts.from,
        to: opts.to,
        speedBand: null,
        vesselIdCount: 0,
        clippedToPolygon: (opts.polygons as unknown[])?.length > 0,
        cells: [],
        cellCount: 0,
      };
    },
    getTracks: async () => ({ from: "", to: "", vessels: [] }),
  } as unknown as AisClickhouseRepository;
}

async function postEffort(
  app: ReturnType<typeof createAisRouter>,
  body: unknown,
): Promise<Response> {
  return await app.request("/effort", {
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

describe("POST /effort — validation", () => {
  test("400 on non-JSON body", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await app.request("/effort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("400 when neither polygon nor bbox given", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postEffort(app, { window: "7d" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("polygon or bbox");
  });

  test("400 on a 2-vertex ring", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postEffort(app, {
      polygon: {
        type: "Polygon",
        coordinates: [
          [
            [-9, 60],
            [-8, 61],
          ],
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  test("400 on out-of-range coordinates", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postEffort(app, {
      polygon: {
        type: "Polygon",
        coordinates: [
          [
            [-999, 60],
            [-8, 60],
            [-8, 61],
            [-999, 60],
          ],
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  test("400 on wrong geometry type", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postEffort(app, {
      polygon: { type: "LineString", coordinates: SQUARE },
    });
    expect(res.status).toBe(400);
  });

  test("400 when total vertices exceed the cap", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const bigRing = Array.from({ length: 1200 }, (_, i) => [
      -9 + (i % 100) / 1000,
      60 + Math.floor(i / 100) / 1000,
    ]);
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [bigRing] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("vertices");
  });

  test("400 when polygon count exceeds the cap", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postEffort(app, {
      polygon: {
        type: "MultiPolygon",
        coordinates: Array.from({ length: 11 }, () => [SQUARE]),
      },
    });
    expect(res.status).toBe(400);
  });

  test("400 on an invalid vesselId", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
      vesselIds: [12, "abc"],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /effort — parsing", () => {
  test("Polygon reaches the repo as one ring; bbox derived from it", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect((o.polygons as unknown[]).length).toBe(1);
    expect(o.minLon).toBe(-9);
    expect(o.maxLon).toBe(-8);
    expect(o.minLat).toBe(60.5);
    expect(o.maxLat).toBe(61.2);
  });

  test("unclosed ring is auto-closed", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const open = SQUARE.slice(0, 4);
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [open] },
    });
    expect(res.status).toBe(200);
    const rings = (captured.opts as { polygons: number[][][] }).polygons;
    expect(rings[0]?.at(0)).toEqual(rings[0]?.at(-1) as number[]);
  });

  test("MultiPolygon → one outer ring per polygon (holes dropped)", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const hole = [
      [-8.8, 60.7],
      [-8.2, 60.7],
      [-8.2, 61.0],
      [-8.8, 60.7],
    ];
    const square2 = SQUARE.map(([lng, lat]) => [(lng as number) + 3, lat]);
    const res = await postEffort(app, {
      polygon: {
        type: "MultiPolygon",
        coordinates: [[SQUARE, hole], [square2]],
      },
    });
    expect(res.status).toBe(200);
    const rings = (captured.opts as { polygons: number[][][] }).polygons;
    expect(rings.length).toBe(2);
  });

  test("explicit bbox overrides the polygon-derived one", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
      bbox: [-20, 55, 0, 65],
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, number>;
    expect(o.minLon).toBe(-20);
    expect(o.maxLat).toBe(65);
  });

  test("bbox alone (no polygon) is accepted", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, { bbox: "-20,55,0,65" });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.polygons).toBeUndefined();
  });

  test("defaults: speed 0.3–5.5 kn, gap 1800 s, limit 100", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, number>;
    expect(o.minKnots).toBe(0.3);
    expect(o.maxKnots).toBe(5.5);
    expect(o.maxGapSeconds).toBe(1800);
    expect(o.limit).toBe(100);
  });

  test("overrides pass through; out-of-range values clamp", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
      minKnots: 1,
      maxKnots: 5,
      maxGapMinutes: 60,
      limit: 250,
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, number>;
    expect(o.minKnots).toBe(1);
    expect(o.maxKnots).toBe(5);
    expect(o.maxGapSeconds).toBe(3600);
    expect(o.limit).toBe(250);

    const res2 = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
      maxGapMinutes: 0,
      limit: 9999,
    });
    expect(res2.status).toBe(200);
    const o2 = captured.opts as Record<string, number>;
    expect(o2.maxGapSeconds).toBe(60);
    expect(o2.limit).toBe(500);
  });

  test("YTD-length from/to range is forwarded verbatim", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, string>;
    expect(o.from).toBe("2026-01-01T00:00:00.000Z");
    expect(o.to).toBe("2026-07-02T00:00:00.000Z");
  });

  test("vesselIds gear filter passes through", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await postEffort(app, {
      polygon: { type: "Polygon", coordinates: [SQUARE] },
      vesselIds: [8, 9, 10, 9],
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.vesselIds).toEqual([8, 9, 10]);
  });
});

describe("POST /density — polygon clip", () => {
  test("polygon reaches getDensityGrid; bbox derived when absent", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await app.request("/density", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        polygon: { type: "Polygon", coordinates: [SQUARE] },
        window: "7d",
      }),
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect((o.polygons as unknown[]).length).toBe(1);
    expect(o.minLon).toBe(-9);
    expect(o.maxLat).toBe(61.2);
  });

  test("POST /density without polygon keeps old behaviour", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await app.request("/density", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bbox: "0,0,1,1" }),
    });
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.polygons).toBeUndefined();
  });
});
