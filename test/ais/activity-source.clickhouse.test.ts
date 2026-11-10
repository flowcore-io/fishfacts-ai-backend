/**
 * Executes both activity query builders against a REAL ClickHouse, on tiny
 * synthetic tables made by the production DDL (runClickhouseMigrations), and
 * asserts the minutes they return. The string guards in activity-source.test.ts
 * cannot see units, the gap rule or how the bbox interacts with the lag; this
 * file can.
 *
 * Runs when TEST_CLICKHOUSE_URL is set (CI sets it, with a ClickHouse service
 * container). Without it the suite is skipped, loudly. With it, any setup
 * failure fails the suite: a configured ClickHouse that cannot be reached is a
 * broken test environment, never a pass.
 *
 *   docker run -d --rm -p 127.0.0.1:18124:8123 -e CLICKHOUSE_PASSWORD=test \
 *     clickhouse/clickhouse-server:24.10
 *   TEST_CLICKHOUSE_URL=http://127.0.0.1:18124 TEST_CLICKHOUSE_PASSWORD=test \
 *     bun test test/ais/activity-source.clickhouse.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import {
  ACTIVITY_DEFAULT_FLAGS,
  ACTIVITY_DEFAULT_TYPES,
  type ActivityBbox,
  type ActivityCellRow,
  activityCellIndex,
  mergeHoverRows,
} from "../../src/ais/activity";
import {
  type ActivityHoverRequest,
  ClickhouseActivitySource,
} from "../../src/ais/activity-source";
import { runClickhouseMigrations } from "../../src/ais/clickhouse-migrate";
import type { Env } from "../../src/env";

const CH_URL = process.env.TEST_CLICKHOUSE_URL;
const CH_USER = process.env.TEST_CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.TEST_CLICKHOUSE_PASSWORD ?? "";
const DATABASE = `activity_test_${process.pid}_${Date.now()}`;

if (!CH_URL) {
  console.warn(
    "[activity-source.clickhouse.test] SKIPPED: set TEST_CLICKHOUSE_URL to execute the activity SQL",
  );
}

const FLAGS = [...ACTIVITY_DEFAULT_FLAGS].sort();
const TYPES = [...ACTIVITY_DEFAULT_TYPES].sort((a, b) => a - b);
/** Inside type 3's [1, 5] kn band. */
const KN = 3;
/** The contract's North Atlantic region. */
const NA: ActivityBbox = [-30, 55, 35, 80];

/** Every scenario has its own vessel and its own day, so they never mix. */
const V = {
  gapRule: 1,
  leavesAndReturns: 2,
  entersFromOutside: 3,
  straddlesEdge: 4,
  antimeridianWest: 5,
  antimeridianEast: 6,
  twoWindows: 7,
  nonFishingType: 8,
  outsidePartOnly: 9,
  insidePartPartner: 10,
} as const;

type Fix = {
  vessel: number;
  at: string; // ISO
  lat: number;
  lon: number;
  speed?: number | null;
};

let sourceId = 0;
function row(f: Fix) {
  const t = new Date(f.at).toISOString().replace("T", " ").replace("Z", "");
  return {
    source_id: ++sourceId,
    vessel_id: f.vessel,
    latitude: f.lat,
    longitude: f.lon,
    speed: f.speed === undefined ? KN : f.speed,
    event_time: t,
    ingest_time: t,
    observed_at: t,
    source: "test",
  };
}

const day = (d: string, hhmm: string) => `2025-10-${d}T${hhmm}:00Z`;

const FIXES: Fix[] = [
  // Gap rule, one cell: 10 + 10 + (dup) + 30 (exactly the cap) + 0 (31 > cap)
  // + 5 = 55 min. The 9 kn fix is out of band: dropped, not a lag boundary.
  ...(
    [
      ["00:00", KN],
      ["00:10", KN],
      ["00:10", KN],
      ["00:15", 9],
      ["00:20", KN],
      ["00:50", KN],
      ["01:21", KN],
      ["01:26", KN],
    ] as const
  ).map(([t, speed]) => ({
    vessel: V.gapRule,
    at: day("01", t),
    lat: 62.01,
    lon: -6.75,
    speed,
  })),

  // The cold review's case: inside NA, out across lat 55 for one fix, back in.
  { vessel: V.leavesAndReturns, at: day("02", "00:00"), lat: 55.01, lon: 0.05 },
  { vessel: V.leavesAndReturns, at: day("02", "00:10"), lat: 54.97, lon: 0.05 },
  { vessel: V.leavesAndReturns, at: day("02", "00:20"), lat: 55.01, lon: 0.05 },

  // Starts outside NA, then enters: the first fix inside is credited the
  // 10 min since the fix outside it.
  {
    vessel: V.entersFromOutside,
    at: day("03", "00:00"),
    lat: 54.97,
    lon: 0.05,
  },
  {
    vessel: V.entersFromOutside,
    at: day("03", "00:10"),
    lat: 55.01,
    lon: 0.05,
  },
  {
    vessel: V.entersFromOutside,
    at: day("03", "00:20"),
    lat: 55.01,
    lon: 0.05,
  },

  // A cell that straddles the bbox edge (cell [54.99, 55.02) vs minLat 55):
  // fixes on both sides of the edge, all in that one cell: 10 + 10 + 25 min.
  // (Clipped to the bbox, the two inside fixes would be 45 min apart: 0.)
  { vessel: V.straddlesEdge, at: day("04", "00:00"), lat: 55.01, lon: 0.05 },
  { vessel: V.straddlesEdge, at: day("04", "00:10"), lat: 54.995, lon: 0.05 },
  { vessel: V.straddlesEdge, at: day("04", "00:20"), lat: 54.995, lon: 0.05 },
  { vessel: V.straddlesEdge, at: day("04", "00:45"), lat: 55.01, lon: 0.05 },

  // A returned edge cell [54.99, 55.02) that one vessel fishes only in the part
  // OUTSIDE the bbox (minLat 55): no raw fix of its is inside the bbox, but
  // its minutes belong to a cell the regional answer returns.
  { vessel: V.outsidePartOnly, at: day("08", "00:00"), lat: 54.995, lon: 0.05 },
  { vessel: V.outsidePartOnly, at: day("08", "00:10"), lat: 54.995, lon: 0.05 },
  {
    vessel: V.insidePartPartner,
    at: day("08", "00:00"),
    lat: 55.01,
    lon: 0.05,
  },
  {
    vessel: V.insidePartPartner,
    at: day("08", "00:10"),
    lat: 55.01,
    lon: 0.05,
  },

  // The antimeridian, one vessel on each side, each on its own day.
  {
    vessel: V.antimeridianWest,
    at: day("05", "00:00"),
    lat: -40,
    lon: -179.95,
  },
  {
    vessel: V.antimeridianWest,
    at: day("05", "00:10"),
    lat: -40,
    lon: -179.95,
  },
  { vessel: V.antimeridianEast, at: day("06", "00:00"), lat: -40, lon: 179.95 },
  { vessel: V.antimeridianEast, at: day("06", "00:10"), lat: -40, lon: 179.95 },

  // Two adjacent hover windows: 00:00–01:00 and 01:00–02:00.
  ...["00:30", "00:50", "01:05", "01:15"].map((t) => ({
    vessel: V.twoWindows,
    at: day("07", t),
    lat: 62.01,
    lon: -6.75,
  })),

  // A registered non-fishing type at fishing speed, right on scenario 1's cell.
  { vessel: V.nonFishingType, at: day("01", "00:00"), lat: 62.01, lon: -6.75 },
  { vessel: V.nonFishingType, at: day("01", "00:10"), lat: 62.01, lon: -6.75 },
];

const REGISTRY = [
  ...Object.values(V)
    .filter((id) => id !== V.nonFishingType)
    .map((vessel_id) => ({
      vessel_id,
      type_id: 3,
      flag: "NZ",
      name: `Test ${vessel_id}`,
    })),
  { vessel_id: V.nonFishingType, type_id: 1, flag: "NZ", name: "Cargo" },
];

let admin: ClickHouseClient | null = null;
let client: ClickHouseClient | null = null;
let source: ClickhouseActivitySource;

function chEnv(): Env {
  return {
    CLICKHOUSE_URL: CH_URL,
    CLICKHOUSE_USER: CH_USER,
    CLICKHOUSE_PASSWORD: CH_PASSWORD,
    CLICKHOUSE_DATABASE: DATABASE,
    CLICKHOUSE_CLUSTER: "",
  } as Env;
}

/** Heatmap minutes per cell key `"ix,iy"`, summed over flags/types. */
async function cells(
  d: string,
  bbox: ActivityBbox | null,
  nextDay = String(Number(d) + 1).padStart(2, "0"),
): Promise<Map<string, number>> {
  const rows: ActivityCellRow[] = await source.getActivityCells({
    from: day(d, "00:00"),
    to: day(nextDay, "00:00"),
    bbox,
    flags: FLAGS,
    types: TYPES,
  });
  return new Map(
    rows.map(([ix, iy, , w]) => [
      `${ix},${iy}`,
      w.reduce((sum, [, , minutes]) => sum + Number(minutes), 0),
    ]),
  );
}

const cellKey = (lat: number, lon: number) =>
  activityCellIndex(lon, lat).join(",");

async function hover(
  windows: ActivityHoverRequest["windows"],
  lat: number,
  lon: number,
  radiusKm: number,
) {
  return source.getHoverRows({
    windows,
    lat,
    lon,
    radiusKm,
    flags: FLAGS,
    types: TYPES,
  });
}

const dayWindow = (d: string) => ({
  from: day(d, "00:00"),
  to: day(String(Number(d) + 1).padStart(2, "0"), "00:00"),
});

describe.skipIf(!CH_URL)("activity SQL, executed on ClickHouse", () => {
  beforeAll(async () => {
    // No try/catch: a configured ClickHouse that fails setup fails the suite.
    await runClickhouseMigrations(chEnv());
    admin = createClient({
      url: CH_URL,
      username: CH_USER,
      password: CH_PASSWORD,
    });
    client = createClient({
      url: CH_URL,
      username: CH_USER,
      password: CH_PASSWORD,
      database: DATABASE,
    });
    source = new ClickhouseActivitySource(client);
    await client.insert({
      table: "ais_position_fixes",
      values: FIXES.map(row),
      format: "JSONEachRow",
    });
    await source.writeRegistrySnapshot(
      REGISTRY,
      Date.parse(day("01", "00:00")),
    );
    expect(await source.isReady()).toBe(true);
  });

  afterAll(async () => {
    await client?.close();
    if (admin) {
      await admin.command({ query: `DROP DATABASE IF EXISTS \`${DATABASE}\`` });
      await admin.close();
    }
  });

  test("minutes are the time between in-band fixes, the 30-min cap included, the 31st minute not", async () => {
    const map = await cells("01", null);
    expect(map.get(cellKey(62.01, -6.75))).toBeCloseTo(55, 9);
    expect(map.size).toBe(1); // the non-fishing type adds no cell and no minute
    const rows = await hover([dayWindow("01")], 62.025, -6.75, 1);
    expect(rows.map((r) => [r.vesselId, r.minutes])).toEqual([[V.gapRule, 55]]);
  });

  test("leave the bbox and re-enter: the regional cell keeps the global minutes (A3)", async () => {
    const inside = cellKey(55.01, 0.05);
    const outside = cellKey(54.97, 0.05);
    const global = await cells("02", null);
    const regional = await cells("02", NA);
    expect(global.get(inside)).toBeCloseTo(10, 9);
    expect(global.get(outside)).toBeCloseTo(10, 9);
    expect(regional.get(inside)).toBeCloseTo(10, 9);
    expect(regional.has(outside)).toBe(false); // outside the bbox: not returned
    const rows = await hover([dayWindow("02")], 55.005, 0.05, 1);
    expect(rows.map((r) => r.minutes)).toEqual([10]);
  });

  test("the first fix inside the bbox is credited the gap from the fix outside it", async () => {
    const inside = cellKey(55.01, 0.05);
    const global = await cells("03", null);
    const regional = await cells("03", NA);
    expect(global.get(inside)).toBeCloseTo(20, 9);
    expect(regional.get(inside)).toBeCloseTo(20, 9);
    const rows = await hover([dayWindow("03")], 55.005, 0.05, 1);
    expect(rows.map((r) => r.minutes)).toEqual([20]);
  });

  test("a cell straddling the bbox edge is returned whole", async () => {
    const edge = cellKey(55.01, 0.05);
    expect(cellKey(54.995, 0.05)).toBe(edge);
    const global = await cells("04", null);
    const regional = await cells("04", NA);
    expect(global.get(edge)).toBeCloseTo(45, 9);
    expect(regional.get(edge)).toBeCloseTo(45, 9);
  });

  test("a vessel only in the outside part of a returned edge cell still counts there", async () => {
    const edge = cellKey(55.01, 0.05);
    expect(cellKey(54.995, 0.05)).toBe(edge);
    const global = await cells("08", null);
    const regional = await cells("08", NA);
    expect(global.get(edge)).toBeCloseTo(20, 9);
    expect(regional.get(edge)).toBeCloseTo(20, 9);
    const rows = await hover([dayWindow("08")], 55.005, 0.05, 1);
    expect(
      rows
        .map((r) => [r.vesselId, r.minutes])
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
    ).toEqual([
      [V.outsidePartOnly, 10],
      [V.insidePartPartner, 10],
    ]);
  });

  test("regional = global = hover, cell by cell, for every scenario day", async () => {
    for (const d of ["01", "02", "03", "04", "07", "08"]) {
      const global = await cells(d, null);
      const regional = await cells(d, NA);
      for (const [key, minutes] of regional) {
        expect(global.get(key)).toBeCloseTo(minutes, 9);
      }
      for (const [key, minutes] of global) {
        const [ix = 0, iy = 0] = key.split(",").map(Number);
        const [lon, lat] = [(ix + 0.5) * 0.1, (iy + 0.5) * 0.03];
        const rows = await hover([dayWindow(d)], lat, lon, 1);
        expect(rows.reduce((s, r) => s + r.minutes, 0)).toBeCloseTo(minutes, 9);
      }
    }
  });

  test("antimeridian: a hover east of ±180 finds the vessel just west of it", async () => {
    const global = await cells("05", null);
    expect(global.get(cellKey(-40, -179.95))).toBeCloseTo(10, 9);
    const rows = await hover([dayWindow("05")], -40.005, 179.95, 25);
    expect(rows.map((r) => [r.vesselId, r.minutes])).toEqual([
      [V.antimeridianWest, 10],
    ]);
  });

  test("antimeridian: a hover west of ±180 finds the vessel just east of it", async () => {
    const global = await cells("06", null);
    expect(global.get(cellKey(-40, 179.95))).toBeCloseTo(10, 9);
    const rows = await hover([dayWindow("06")], -40.005, -179.95, 25);
    expect(rows.map((r) => [r.vesselId, r.minutes])).toEqual([
      [V.antimeridianEast, 10],
    ]);
  });

  test("hover windows: each is its own track, as its own heatmap is, and the minutes add", async () => {
    const w0 = { from: day("07", "00:00"), to: day("07", "01:00") };
    const w1 = { from: day("07", "01:00"), to: day("07", "02:00") };
    const rows = await hover([w0, w1], 62.025, -6.75, 1);
    // w0: 00:50 is credited 20; w1: 01:05 starts a new track, 01:15 gets 10
    expect(
      rows
        .map((r) => [r.window, r.minutes])
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
    ).toEqual([
      [0, 20],
      [1, 10],
    ]);
    const merged = mergeHoverRows(rows);
    expect(merged.vessels).toHaveLength(1);
    expect(merged.vessels[0]?.minutes).toBeCloseTo(30, 9);
  });
});
