import { describe, expect, test } from "bun:test";
import type { AisClickhouseRepository } from "../../src/ais/clickhouse-repository";
import { createAisRouter } from "../../src/ais/routes";

type Captured = { opts?: Record<string, unknown> };

function mockRepo(captured: Captured): AisClickhouseRepository {
  return {
    getDensityGrid: async (opts: Record<string, unknown>) => {
      captured.opts = opts;
      return {
        gridDeg: opts.gridDeg,
        from: opts.from,
        to: opts.to,
        speedBand: null,
        cells: [{ lat: 71, lng: 25, fixes: 10, vessels: 3 }],
        cellCount: 1,
      };
    },
    getTracks: async () => ({ from: "", to: "", vessels: [] }),
  } as unknown as AisClickhouseRepository;
}

describe("GET /density", () => {
  test("400 when bbox missing", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await app.request("/density");
    expect(res.status).toBe(400);
  });

  test("400 on inverted bbox (min >= max)", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await app.request("/density?bbox=10,70,5,60");
    expect(res.status).toBe(400);
  });

  test("parses bbox + grid + window + speed band", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await app.request(
      "/density?bbox=10,70,40,76&gridDeg=0.2&window=7d&minKnots=1&maxKnots=5",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cells: unknown[] };
    expect(body.cells.length).toBe(1);
    const o = captured.opts as Record<string, number>;
    expect(o.minLon).toBe(10);
    expect(o.minLat).toBe(70);
    expect(o.maxLon).toBe(40);
    expect(o.maxLat).toBe(76);
    expect(o.gridDeg).toBe(0.2);
    expect(o.minKnots).toBe(1);
    expect(o.maxKnots).toBe(5);
  });

  test("clamps gridDeg to [0.02,1] and defaults limit", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await app.request("/density?bbox=0,0,1,1&gridDeg=99");
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, number>;
    expect(o.gridDeg).toBe(1);
    expect(o.limit).toBe(2000);
  });

  test("rejects inverted speed band", async () => {
    const app = createAisRouter({ repository: mockRepo({}) });
    const res = await app.request(
      "/density?bbox=0,0,1,1&minKnots=5&maxKnots=1",
    );
    expect(res.status).toBe(400);
  });

  test("omits speed band when not given", async () => {
    const captured: Captured = {};
    const app = createAisRouter({ repository: mockRepo(captured) });
    const res = await app.request("/density?bbox=0,0,1,1");
    expect(res.status).toBe(200);
    const o = captured.opts as Record<string, unknown>;
    expect(o.minKnots).toBeUndefined();
    expect(o.maxKnots).toBeUndefined();
  });
});
