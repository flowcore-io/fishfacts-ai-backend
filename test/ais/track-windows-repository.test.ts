import { describe, expect, test } from "bun:test";
import {
  AIS_TRACK_WINDOWS_MAX,
  AisClickhouseRepository,
} from "../../src/ais/clickhouse-repository";

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

const FOUR_HOURS = {
  vesselId: 913,
  from: "2025-03-04T06:00:00.000Z",
  to: "2025-03-04T10:00:00.000Z",
};

function repo(captured: Parameters<typeof fakeClient>[0]) {
  // biome-ignore lint/suspicious/noExplicitAny: fake client, not the real one.
  return new AisClickhouseRepository(fakeClient(captured) as any, ENV);
}

describe("getTrackWindows SQL construction", () => {
  test("one UNION ALL branch per window, never an OR-chain", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [FOUR_HOURS, { ...FOUR_HOURS, vesselId: 14 }, FOUR_HOURS],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    const q = captured.query ?? "";

    expect(q.match(/UNION ALL/g) ?? []).toHaveLength(2);
    expect(q.match(/FROM ais_position_fixes/g) ?? []).toHaveLength(3);

    // Regression guard with a measured reason: on 50 windows scattered over 50
    // months an OR-chain read 24.8 M rows against this shape's 729 k, and took
    // 2,518 ms against 134 ms, for identical results. Anyone tempted to "tidy"
    // this into one WHERE is undoing a 19x.
    expect(q).not.toMatch(/\)\s+OR\s+\(vessel_id/);
  });

  test("each window binds its own parameters, and nothing is interpolated", async () => {
    const captured: {
      query?: string;
      params?: Record<string, unknown>;
    } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [FOUR_HOURS, { ...FOUR_HOURS, vesselId: 14 }],
      maxPointsPerWindow: 4000,
    });
    await r.close();

    expect(captured.query).toContain("{v0:Int32}");
    expect(captured.query).toContain("{f1:DateTime64(3)}");
    expect(captured.params?.v0).toBe(913);
    expect(captured.params?.v1).toBe(14);
    // ISO in, ClickHouse datetime out — no 'T' and no trailing 'Z'.
    expect(captured.params?.f0).toBe("2025-03-04 06:00:00.000");
    expect(captured.params?.t0).toBe("2025-03-04 10:00:00.000");
    // The vessel id must never reach the SQL text itself.
    expect(captured.query).not.toContain("vessel_id = 913");
  });

  test("windows are inclusive at both ends, like FishFacts and getFixesForWindows", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [FOUR_HOURS],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    // Whitespace-free because the branch text is repeated once per window and
    // is parsed against max_query_size — see the repository comment.
    expect(captured.query).toContain("event_time>={f0:DateTime64(3)}");
    expect(captured.query).toContain("event_time<={t0:DateTime64(3)}");
  });

  // Guards the cap against the real parser limit rather than an estimate: at
  // 500 windows the readable, indented form of this query was 262 KB and
  // ClickHouse rejected it outright.
  test("a full request of windows stays well inside the raised query-size limit", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: Array.from({ length: AIS_TRACK_WINDOWS_MAX }, () => FOUR_HOURS),
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect((captured.query ?? "").length).toBeLessThan(400_000);
  });

  test("the branch index is width-pinned so UNION ALL branches agree on types", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: Array.from({ length: 300 }, () => FOUR_HOURS),
      maxPointsPerWindow: 4000,
    });
    await r.close();
    // A bare literal would be UInt8 at branch 5 and UInt16 at branch 300.
    expect(captured.query).toContain("toUInt32(0)");
    expect(captured.query).toContain("toUInt32(299)");
  });

  test("the bucket is sized so the LIMIT backstop cannot bite", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    // 4 h = 14 400 s over 4 000 points -> floor(3.6) + 1 = 4 s, at most 3 601
    // buckets against a cap of 4 000.
    await r.getTrackWindows({
      windows: [FOUR_HOURS],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(captured.query).toContain("INTERVAL 4 SECOND");
    expect(captured.query).toContain("LIMIT 4000");
  });

  /**
   * The boundary the obvious rule gets wrong, and the reason it is `floor + 1`
   * rather than `ceil`.
   *
   * A window closed at BOTH ends holds `seconds + 1` seconds' worth of fixes,
   * so at `seconds === step * cap` a ceiling leaves room for exactly one
   * bucket too many and `ORDER BY t LIMIT cap` drops the LATEST one -- the
   * tow's tail, which is the failure the downsample exists to avoid. Verified
   * against production: sweeping lengths against start offsets at a cap of
   * 400, `ceil` overran in 25 cases and `floor + 1` in none.
   */
  test("an exact multiple of the cap does not overrun it", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      // 8 000 s at a cap of 4 000: ceil gives 2 s and 4 001 buckets.
      windows: [{ ...FOUR_HOURS, to: "2025-03-04T08:13:20.000Z" }],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(captured.query).toContain("INTERVAL 3 SECOND");
    expect(captured.query).not.toContain("INTERVAL 2 SECOND");
  });

  /**
   * `toStartOfInterval` aligns to the EPOCH unless it is given an origin, so a
   * window that starts mid-bucket straddles one extra partial bucket. Pinning
   * the buckets to the window's own start closes that, and it is free: `from`
   * is already a bound parameter. Both this and the `floor + 1` above are
   * needed -- with epoch alignment the sweep still overran in 5 cases.
   */
  test("buckets are aligned to the window start, not to the epoch", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [FOUR_HOURS],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(captured.query).toContain(
      "toStartOfInterval(event_time, INTERVAL 4 SECOND, {f0:DateTime64(3)})",
    );
  });

  test("a window shorter than the cap buckets at one second", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [{ ...FOUR_HOURS, to: "2025-03-04T06:10:00.000Z" }],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(captured.query).toContain("INTERVAL 1 SECOND");
  });

  test("the speed filter is table-qualified so it can't bind to the argMax alias", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [FOUR_HOURS],
      maxPointsPerWindow: 4000,
      minKnots: 0.3,
      maxKnots: 5.5,
    });
    await r.close();
    const q = captured.query ?? "";
    // The SELECT aliases `argMax(speed, …) AS speed`; an unqualified `speed` in
    // WHERE binds to that aggregate and ClickHouse rejects it (Code 184).
    expect(q).toContain("ais_position_fixes.speed >=");
    expect(q).toContain("ais_position_fixes.speed <=");
    expect(q).not.toMatch(/AND speed >=/);
  });

  test("no speed parameters are bound when no band was asked for", async () => {
    const captured: { params?: Record<string, unknown> } = {};
    const r = repo(captured);
    await r.getTrackWindows({
      windows: [FOUR_HOURS],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(captured.params).not.toHaveProperty("minKn");
  });

  test("an empty window list never reaches ClickHouse", async () => {
    const captured: { query?: string } = {};
    const r = repo(captured);
    const out = await r.getTrackWindows({
      windows: [],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(out.windows).toEqual([]);
    expect(captured.query).toBeUndefined();
  });
});

describe("getTrackWindows result mapping", () => {
  const rows = [
    // Deliberately out of order, and branch 2 answers nothing: UNION ALL
    // orders within a branch but makes no promise across them.
    {
      w: 1,
      t: "2025-03-04 07:00:00.000",
      lat: 2,
      lon: 2,
      speed: 4.1,
      heading: null,
      course: null,
      last_status: null,
    },
    {
      w: 0,
      t: "2025-03-04 07:30:00.000",
      lat: 3,
      lon: 3,
      speed: 0.2,
      heading: null,
      course: null,
      last_status: "MOORED",
    },
    {
      w: 0,
      t: "2025-03-04 06:30:00.000",
      lat: 1,
      lon: 1,
      speed: 3.3,
      heading: 90,
      course: 91,
      last_status: "UNDERWAY",
    },
  ];

  test("answers one entry per requested window, in request order", async () => {
    const captured = { rows } as Parameters<typeof fakeClient>[0];
    const r = repo(captured);
    const asked = [
      FOUR_HOURS,
      { ...FOUR_HOURS, vesselId: 14 },
      { ...FOUR_HOURS, vesselId: 21 },
    ];
    const out = await r.getTrackWindows({
      windows: asked,
      maxPointsPerWindow: 4000,
    });
    await r.close();

    expect(out.windows).toHaveLength(3);
    expect(out.windows.map((w) => w.vesselId)).toEqual([913, 14, 21]);
    // An empty window still gets its entry — that is what stops a client
    // matching by index from sliding one tow's track onto the next.
    expect(out.windows[2]).toEqual({ ...asked[2], pointCount: 0, points: [] });
  });

  test("points come back ascending in time, whatever order the branches did", async () => {
    const captured = { rows } as Parameters<typeof fakeClient>[0];
    const r = repo(captured);
    const out = await r.getTrackWindows({
      windows: [FOUR_HOURS, { ...FOUR_HOURS, vesselId: 14 }],
      maxPointsPerWindow: 4000,
    });
    await r.close();

    expect(out.windows[0].points.map((p) => p.t)).toEqual([
      "2025-03-04T06:30:00.000Z",
      "2025-03-04T07:30:00.000Z",
    ]);
    expect(out.windows[0].pointCount).toBe(2);
    expect(out.windows[0].points[0]).toEqual({
      t: "2025-03-04T06:30:00.000Z",
      lat: 1,
      lon: 1,
      speed: 3.3,
      heading: 90,
      course: 91,
      status: "UNDERWAY",
    });
    expect(out.windows[1].pointCount).toBe(1);
  });

  test("the same vessel in two windows gets two answers, not one merged", async () => {
    const captured = {
      rows: [
        {
          w: 0,
          t: "2025-03-04 06:30:00.000",
          lat: 1,
          lon: 1,
          speed: null,
          heading: null,
          course: null,
          last_status: null,
        },
        {
          w: 1,
          t: "2025-03-04 11:30:00.000",
          lat: 2,
          lon: 2,
          speed: null,
          heading: null,
          course: null,
          last_status: null,
        },
      ],
    } as Parameters<typeof fakeClient>[0];
    const r = repo(captured);
    const out = await r.getTrackWindows({
      windows: [
        FOUR_HOURS,
        {
          ...FOUR_HOURS,
          from: "2025-03-04T11:00:00.000Z",
          to: "2025-03-04T12:00:00.000Z",
        },
      ],
      maxPointsPerWindow: 4000,
    });
    await r.close();
    expect(out.windows).toHaveLength(2);
    expect(out.windows.every((w) => w.vesselId === 913)).toBe(true);
    expect(out.windows.map((w) => w.pointCount)).toEqual([1, 1]);
  });
});
