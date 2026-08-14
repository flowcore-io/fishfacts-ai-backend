import { describe, expect, test } from "bun:test";
import { AisClickhouseRepository } from "../../src/ais/clickhouse-repository";

// Same approach as tracks-repository.test.ts: a fake ClickHouse client that
// captures the emitted SQL and replays canned rows, so a SQL-construction bug
// is caught without a live ClickHouse (CI has none).
function fakeClient(captured: {
  query?: string;
  params?: Record<string, unknown>;
  rows?: unknown[];
}) {
  return {
    query: async (opts: {
      query: string;
      query_params?: Record<string, unknown>;
    }) => {
      captured.query = opts.query;
      captured.params = opts.query_params;
      return { json: async () => captured.rows ?? [] };
    },
    insert: async () => {},
    close: async () => {},
  };
}

// biome-ignore lint/suspicious/noExplicitAny: minimal env stub for the ctor.
const ENV = { AIS_CH_BATCH_ROWS: 1000, AIS_CH_FLUSH_MS: 999_999 } as any;

function repo(captured: Parameters<typeof fakeClient>[0]) {
  // biome-ignore lint/suspicious/noExplicitAny: fake client stands in for ClickHouseClient.
  return new AisClickhouseRepository(fakeClient(captured) as any, ENV);
}

describe("getFixesForWindows SQL construction", () => {
  test("many (vessel, window) requests become ONE query", async () => {
    const captured: { query?: string; params?: Record<string, unknown> } = {};
    const repository = repo(captured);
    await repository.getFixesForWindows([
      {
        key: "a",
        vesselId: 11,
        from: "2026-05-26T08:30:00.000Z",
        to: "2026-05-28T08:30:00.000Z",
      },
      {
        key: "b",
        vesselId: 22,
        from: "2026-05-20T00:00:00.000Z",
        to: "2026-05-22T00:00:00.000Z",
      },
    ]);
    await repository.close();

    const query = captured.query ?? "";
    expect(query.match(/vessel_id = \{v\d+:Int32\}/g)).toHaveLength(2);
    expect(query).toContain(" OR ");
    expect(captured.params?.v0).toBe(11);
    expect(captured.params?.v1).toBe(22);
    // Vessel ids and timestamps are bound, never interpolated.
    expect(query).not.toContain("11");
  });

  test("windows are inclusive at both ends — a fix ON the report counts", async () => {
    const captured: { query?: string } = {};
    const repository = repo(captured);
    await repository.getFixesForWindows([
      {
        key: "a",
        vesselId: 11,
        from: "2026-05-26T00:00:00.000Z",
        to: "2026-05-28T00:00:00.000Z",
      },
    ]);
    await repository.close();

    expect(captured.query).toContain("event_time >= {f0:DateTime64(3)}");
    expect(captured.query).toContain("event_time <= {t0:DateTime64(3)}");
  });

  test("NO speed filter — an out-of-band fix is what ends a fishing run", async () => {
    const captured: { query?: string } = {};
    const repository = repo(captured);
    await repository.getFixesForWindows([
      {
        key: "a",
        vesselId: 11,
        from: "2026-05-26T00:00:00.000Z",
        to: "2026-05-28T00:00:00.000Z",
      },
    ]);
    await repository.close();

    // Filtering the band in SQL would delete the very fixes that separate one
    // run from the next, welding two casts into one.
    expect(captured.query).not.toContain("speed >=");
    expect(captured.query).not.toContain("speed IS NOT NULL");
    // ...and the fixes must not be bucket-downsampled either.
    expect(captured.query).not.toContain("toStartOfInterval");
  });

  test("overlapping windows both get the fixes they contain", async () => {
    const captured = {
      rows: [
        {
          vesselId: 11,
          t: "2026-05-27 10:00:00.000",
          lat: 61,
          lon: -6,
          speed: 2,
        },
        {
          vesselId: 11,
          t: "2026-05-27 23:00:00.000",
          lat: 61.1,
          lon: -6.1,
          speed: null,
        },
      ],
    };
    const repository = repo(captured);
    const result = await repository.getFixesForWindows([
      {
        key: "early",
        vesselId: 11,
        from: "2026-05-27T00:00:00.000Z",
        to: "2026-05-27T12:00:00.000Z",
      },
      {
        key: "late",
        vesselId: 11,
        from: "2026-05-27T09:00:00.000Z",
        to: "2026-05-28T00:00:00.000Z",
      },
      {
        key: "other-vessel",
        vesselId: 22,
        from: "2026-05-27T00:00:00.000Z",
        to: "2026-05-28T00:00:00.000Z",
      },
    ]);
    await repository.close();

    expect(result.get("early")).toHaveLength(1);
    expect(result.get("late")).toHaveLength(2);
    expect(result.get("other-vessel")).toEqual([]);
    // A null speed survives the trip as null — never coerced to 0.
    expect(result.get("late")?.[1]?.speed).toBeNull();
    expect(result.get("early")?.[0]?.epochMs).toBe(
      Date.parse("2026-05-27T10:00:00.000Z"),
    );
  });

  test("no requests, no query", async () => {
    const captured: { query?: string } = {};
    const repository = repo(captured);
    const result = await repository.getFixesForWindows([]);
    await repository.close();

    expect(result.size).toBe(0);
    expect(captured.query).toBeUndefined();
  });
});
