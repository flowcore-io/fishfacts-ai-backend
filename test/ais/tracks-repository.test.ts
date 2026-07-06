import { describe, expect, test } from "bun:test";
import { AisClickhouseRepository } from "../../src/ais/clickhouse-repository";

// A fake ClickHouse client that captures the query text getTracks emits, so we
// can assert on the generated SQL without a live ClickHouse. Route-level tests
// mock the whole repository and therefore can't catch a SQL-construction bug —
// this file exists specifically because such a bug (an alias-shadowed `speed`
// in WHERE → ClickHouse ILLEGAL_AGGREGATION) shipped once undetected.
function fakeClient(captured: { query?: string }): {
  query: (opts: { query: string }) => Promise<{ json: () => Promise<[]> }>;
  insert: () => Promise<void>;
  close: () => Promise<void>;
} {
  return {
    query: async (opts: { query: string }) => {
      captured.query = opts.query;
      return { json: async () => [] };
    },
    insert: async () => {},
    close: async () => {},
  };
}

// biome-ignore lint/suspicious/noExplicitAny: minimal env stub for the ctor.
const ENV = { AIS_CH_BATCH_ROWS: 1000, AIS_CH_FLUSH_MS: 999_999 } as any;

// Closed [lng,lat] square around the Faroe Bank.
const SQUARE = [
  [-9, 60.5],
  [-8, 60.5],
  [-8, 61.2],
  [-9, 61.2],
  [-9, 60.5],
];

describe("getTracks SQL construction", () => {
  test("speed filter is table-qualified so it can't bind to the argMax alias", async () => {
    const captured: { query?: string } = {};
    // biome-ignore lint/suspicious/noExplicitAny: fake client stands in for ClickHouseClient.
    const repo = new AisClickhouseRepository(fakeClient(captured) as any, ENV);
    await repo.getTracks({
      vesselIds: [42],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      maxPointsPerVessel: 2000,
      minKnots: 0.3,
      maxKnots: 5.5,
      polygons: [SQUARE],
    });
    await repo.close();

    const q = captured.query ?? "";
    // The SELECT aliases `argMax(speed, event_time) AS speed`; the WHERE speed
    // filter MUST reference the raw column table-qualified, else ClickHouse
    // rejects it (Code 184 ILLEGAL_AGGREGATION).
    expect(q).toContain("ais_position_fixes.speed >=");
    expect(q).toContain("ais_position_fixes.speed <=");
    // Regression guard: never the bare, alias-shadowed form.
    expect(q).not.toMatch(/AND speed >=/);
    // Polygon clip is present and applied before the bucket downsampling.
    expect(q).toContain("pointInPolygon");
    expect(q.indexOf("pointInPolygon")).toBeLessThan(q.indexOf("GROUP BY"));
  });

  test("no polygon / no speed band ⇒ neither filter (GET /tracks parity)", async () => {
    const captured: { query?: string } = {};
    // biome-ignore lint/suspicious/noExplicitAny: fake client stands in for ClickHouseClient.
    const repo = new AisClickhouseRepository(fakeClient(captured) as any, ENV);
    await repo.getTracks({
      vesselIds: [1],
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
      maxPointsPerVessel: 2000,
    });
    await repo.close();

    const q = captured.query ?? "";
    expect(q).not.toContain("pointInPolygon");
    expect(q).not.toContain("speed >=");
  });
});
