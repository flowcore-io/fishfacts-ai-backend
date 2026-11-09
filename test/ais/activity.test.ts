import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_DEFAULT_FLAGS,
  ACTIVITY_DEFAULT_TYPES,
  ACTIVITY_HOVER_MAX_ROWS,
  ACTIVITY_SPEED_BANDS,
  activityCacheKey,
  activityCellCentre,
  activityCellIndex,
  buildActivityFeatureCollection,
  isImmutableWindow,
  mergeHoverRows,
  normaliseRegistryFlag,
  parseActivityQuery,
  parseActivityVesselsQuery,
  vesselsCacheKey,
} from "../../src/ais/activity";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("activity lattice", () => {
  test("centres sit at floor()+½ of the 0.1° × 0.03° lattice", () => {
    // Tórshavn-ish: -6.77 → cell -68 → -6.75; 62.01 / 0.03 = 2067 → 62.025
    expect(activityCellCentre(...activityCellIndex(-6.77, 62.01))).toEqual([
      -6.75, 62.025,
    ]);
    expect(activityCellCentre(...activityCellIndex(-6.77, 62.0))).toEqual([
      -6.75, 61.995,
    ]);
    expect(activityCellCentre(...activityCellIndex(3.21, 56.56))).toEqual([
      3.25, 56.565,
    ]);
  });

  test("negative coordinates floor away from zero (not truncate)", () => {
    // -6.87 must land in [-6.9, -6.8) → centre -6.85, not -6.75 (trunc would give -68)
    expect(activityCellIndex(-6.87, -33.01)).toEqual([-69, -1101]);
    expect(activityCellCentre(-69, -1101)).toEqual([-6.85, -33.015]);
    // Just below zero is the cell left of / below zero, not cell 0
    expect(activityCellCentre(...activityCellIndex(-0.01, -0.01))).toEqual([
      -0.05, -0.015,
    ]);
    expect(activityCellCentre(...activityCellIndex(0.01, 0.01))).toEqual([
      0.05, 0.015,
    ]);
  });

  test("centres are rounded to 3 decimals and end in 5", () => {
    for (const [lon, lat] of [
      [-29.99, 55.001],
      [34.98, 79.99],
      [-179.95, -89.99],
      [12.345678, 64.123456],
    ] as const) {
      const [cx, cy] = activityCellCentre(...activityCellIndex(lon, lat));
      expect(Math.round(cx * 1000) / 1000).toBe(cx);
      expect(Math.round(cy * 1000) / 1000).toBe(cy);
      expect(Math.abs(Math.round(cx * 100) % 10)).toBe(5);
      expect(Math.abs(Math.round(cy * 1000) % 10)).toBe(5);
      // the centre is inside the fix's own cell, within half a cell
      expect(Math.abs(cx - lon)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(cy - lat)).toBeLessThanOrEqual(0.015 + 1e-9);
    }
  });
});

describe("speed bands mirror fishfacts-fe FISHING_SPEED_MAP", () => {
  test("every default type has a band; 28/29 use the FE fallback range", () => {
    for (const type of ACTIVITY_DEFAULT_TYPES) {
      expect(ACTIVITY_SPEED_BANDS[type]).toBeDefined();
    }
    expect(ACTIVITY_SPEED_BANDS[2]).toEqual([0.3, 7.5]);
    expect(ACTIVITY_SPEED_BANDS[3]).toEqual([1, 5]);
    expect(ACTIVITY_SPEED_BANDS[6]).toEqual([0.3, 5]);
    expect(ACTIVITY_SPEED_BANDS[28]).toEqual([0.3, 7.5]);
    expect(ACTIVITY_SPEED_BANDS[29]).toEqual([0.3, 7.5]);
  });

  test("defaults are the FE's 11 flags and 9 types", () => {
    expect([...ACTIVITY_DEFAULT_FLAGS]).toEqual([
      "FO",
      "NO",
      "IS",
      "GL",
      "DK",
      "SE",
      "GB",
      "IE",
      "CA",
      "RU",
      "NZ",
    ]);
    expect([...ACTIVITY_DEFAULT_TYPES]).toEqual([2, 28, 4, 3, 5, 10, 29, 8, 6]);
  });
});

describe("registry flags", () => {
  test("registry SW is Sweden, served as SE", () => {
    expect(normaliseRegistryFlag("SW")).toBe("SE");
    expect(normaliseRegistryFlag(" sw ")).toBe("SE");
  });
  test("other codes are trimmed and upper-cased, empty is null", () => {
    expect(normaliseRegistryFlag("FO    ")).toBe("FO");
    expect(normaliseRegistryFlag("no")).toBe("NO");
    expect(normaliseRegistryFlag("  ")).toBeNull();
    expect(normaliseRegistryFlag(null)).toBeNull();
  });
});

describe("parseActivityQuery", () => {
  const season =
    "from=2025-09-10T00:00:00Z&to=2025-10-29T00:00:00Z&bbox=-30,55,35,80";

  test("a North Atlantic season parses with the default filters", () => {
    const q = parseActivityQuery(params(season), NOW);
    if ("code" in q) throw new Error(q.error);
    expect(q.from).toBe("2025-09-10T00:00:00.000Z");
    expect(q.to).toBe("2025-10-29T00:00:00.000Z");
    expect(q.bbox).toEqual([-30, 55, 35, 80]);
    expect(q.flags).toEqual([...ACTIVITY_DEFAULT_FLAGS].sort());
    expect(q.types).toEqual([...ACTIVITY_DEFAULT_TYPES].sort((a, b) => a - b));
  });

  test.each([
    ["missing from", "to=2025-10-29T00:00:00Z"],
    ["missing to", "from=2025-10-01T00:00:00Z"],
    ["unparseable from", "from=yesterday&to=2025-10-29T00:00:00Z"],
    ["date without time", "from=2025-10-01&to=2025-10-29T00:00:00Z"],
    ["from == to", "from=2025-10-01T00:00:00Z&to=2025-10-01T00:00:00Z"],
    ["from > to", "from=2025-10-02T00:00:00Z&to=2025-10-01T00:00:00Z"],
    ["from before 2021", "from=2020-12-31T23:59:59Z&to=2021-01-10T00:00:00Z"],
    ["to in the future", `from=2026-11-01T00:00:00Z&to=${iso(NOW + 1000)}`],
    [
      "unknown flag",
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&flags=FO,XX",
    ],
    ["empty flags", "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&flags="],
    [
      "unknown type",
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&types=2,9",
    ],
    [
      "non-integer type",
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&types=2,3.5",
    ],
    [
      "bad bbox",
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&bbox=1,2,3",
    ],
    [
      "inverted bbox",
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&bbox=10,60,5,55",
    ],
    [
      "bbox out of range",
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&bbox=-190,55,35,80",
    ],
  ])("400 bad_request: %s", (_name, query) => {
    const q = parseActivityQuery(params(query), NOW);
    expect(q).toMatchObject({ status: 400, code: "bad_request" });
  });

  test("from exactly 2021-01-01 and to exactly now are allowed", () => {
    const q = parseActivityQuery(
      params("from=2021-01-01T00:00:00Z&to=2021-01-08T00:00:00Z"),
      NOW,
    );
    expect("code" in q).toBe(false);
    const r = parseActivityQuery(
      params(`from=${iso(NOW - 7 * DAY)}&to=${iso(NOW)}`),
      NOW,
    );
    expect("code" in r).toBe(false);
  });

  test("92 days is allowed, 92 days + 1 ms is window_too_long", () => {
    const from = Date.parse("2025-08-01T00:00:00Z");
    const ok = parseActivityQuery(
      params(`from=${iso(from)}&to=${iso(from + 92 * DAY)}&bbox=-30,55,35,80`),
      NOW,
    );
    expect("code" in ok).toBe(false);
    const tooLong = parseActivityQuery(
      params(
        `from=${iso(from)}&to=${iso(from + 92 * DAY + 1)}&bbox=-30,55,35,80`,
      ),
      NOW,
    );
    expect(tooLong).toMatchObject({ status: 422, code: "window_too_long" });
  });

  test("31 days global is allowed, 31 days + 1 ms global is global_window_too_long", () => {
    const from = Date.parse("2025-10-01T00:00:00Z");
    const ok = parseActivityQuery(
      params(`from=${iso(from)}&to=${iso(from + 31 * DAY)}`),
      NOW,
    );
    expect("code" in ok).toBe(false);
    const tooLong = parseActivityQuery(
      params(`from=${iso(from)}&to=${iso(from + 31 * DAY + 1)}`),
      NOW,
    );
    expect(tooLong).toMatchObject({
      status: 422,
      code: "global_window_too_long",
    });
  });

  test("over 31 days needs a bbox of at most 2 500 deg²", () => {
    const window = "from=2025-09-10T00:00:00Z&to=2025-10-29T00:00:00Z";
    // 50 × 50 = 2 500 exactly: allowed
    const atLimit = parseActivityQuery(
      params(`${window}&bbox=-25,30,25,80`),
      NOW,
    );
    expect("code" in atLimit).toBe(false);
    // 50.1 × 50 = 2 505: too big
    const over = parseActivityQuery(
      params(`${window}&bbox=-25.1,30,25,80`),
      NOW,
    );
    expect(over).toMatchObject({ status: 422, code: "global_window_too_long" });
  });

  test("a window over 92 days reports window_too_long even without a bbox", () => {
    const q = parseActivityQuery(
      params("from=2025-01-01T00:00:00Z&to=2025-06-01T00:00:00Z"),
      NOW,
    );
    expect(q).toMatchObject({ status: 422, code: "window_too_long" });
  });
});

describe("cache keys", () => {
  test("equivalent requests normalise to the same key", () => {
    const a = parseActivityQuery(
      params(
        "from=2025-09-10T00:00:00Z&to=2025-10-29T00:00:00Z&bbox=-30,55,35,80&flags=NO,FO&types=3,2",
      ),
      NOW,
    );
    const b = parseActivityQuery(
      params(
        "from=2025-09-10T00:00:00.000Z&to=2025-10-29T02:00:00%2B02:00&bbox=-30.0,55,35.000,80&flags=fo,NO,FO&types=2,3,2",
      ),
      NOW,
    );
    if ("code" in a || "code" in b) throw new Error("parse failed");
    expect(activityCacheKey(a)).toBe(activityCacheKey(b));
  });

  test("absent filters key the same as the explicit defaults", () => {
    const a = parseActivityQuery(
      params("from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z"),
      NOW,
    );
    const b = parseActivityQuery(
      params(
        `from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&flags=${ACTIVITY_DEFAULT_FLAGS.join(",")}&types=${ACTIVITY_DEFAULT_TYPES.join(",")}`,
      ),
      NOW,
    );
    if ("code" in a || "code" in b) throw new Error("parse failed");
    expect(activityCacheKey(a)).toBe(activityCacheKey(b));
  });

  test("any parameter that changes the answer changes the key", () => {
    const base =
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z&bbox=-30,55,35,80";
    const keys = [
      base,
      base.replace("10-08", "10-09"),
      base.replace("10-01", "09-30"),
      base.replace("bbox=-30,55,35,80", "bbox=-30,55,35,79"),
      "from=2025-10-01T00:00:00Z&to=2025-10-08T00:00:00Z",
      `${base}&flags=FO`,
      `${base}&types=2`,
    ].map((query) => {
      const q = parseActivityQuery(params(query), NOW);
      if ("code" in q) throw new Error(q.error);
      return activityCacheKey(q);
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("vessels keys ignore window order and round lat/lon to 3 dp and radius to 1 dp", () => {
    const a = parseActivityVesselsQuery(
      params(
        "windows=2025-09-10T00:00:00Z/2025-10-29T00:00:00Z,2024-09-10T00:00:00Z/2024-10-29T00:00:00Z&lat=62.00011&lon=-6.80004&radiusKm=12.04",
      ),
      NOW,
    );
    const b = parseActivityVesselsQuery(
      params(
        "windows=2024-09-10T00:00:00Z/2024-10-29T00:00:00Z,2025-09-10T00:00:00Z/2025-10-29T00:00:00Z&lat=62.0004&lon=-6.8&radiusKm=12",
      ),
      NOW,
    );
    if ("code" in a || "code" in b) throw new Error("parse failed");
    expect(vesselsCacheKey(a)).toBe(vesselsCacheKey(b));
    // the query actually run uses the rounded values, so the key never lies
    expect(a.lat).toBe(62);
    expect(a.lon).toBe(-6.8);
    expect(a.radiusKm).toBe(12);
  });
});

describe("isImmutableWindow", () => {
  test("a window ending more than 24 h ago is immutable", () => {
    expect(isImmutableWindow(NOW - DAY - 1, NOW)).toBe(true);
    expect(isImmutableWindow(NOW - DAY, NOW)).toBe(false);
    expect(isImmutableWindow(NOW - 3_600_000, NOW)).toBe(false);
  });
});

describe("parseActivityVesselsQuery", () => {
  const ok =
    "windows=2025-09-10T00:00:00Z/2025-10-29T00:00:00Z&lat=62&lon=-6.8&radiusKm=10";

  test("parses windows, point, radius and default filters", () => {
    const q = parseActivityVesselsQuery(params(ok), NOW);
    if ("code" in q) throw new Error(q.error);
    expect(q.windows).toEqual([
      { from: "2025-09-10T00:00:00.000Z", to: "2025-10-29T00:00:00.000Z" },
    ]);
    expect(q.flags.length).toBe(11);
    expect(q.types.length).toBe(9);
  });

  test.each([
    ["missing windows", "lat=62&lon=-6.8&radiusKm=10"],
    ["window without slash", ok.replace("Z/2025", "Z2025")],
    [
      "7 windows",
      `windows=${Array(7).fill("2025-09-10T00:00:00Z/2025-09-11T00:00:00Z").join(",")}&lat=62&lon=-6.8&radiusKm=10`,
    ],
    ["missing lat", ok.replace("lat=62&", "")],
    ["lat out of range", ok.replace("lat=62", "lat=91")],
    ["lon out of range", ok.replace("lon=-6.8", "lon=-181")],
    ["radius 0", ok.replace("radiusKm=10", "radiusKm=0")],
    ["radius over 100", ok.replace("radiusKm=10", "radiusKm=100.1")],
    ["radius not a number", ok.replace("radiusKm=10", "radiusKm=ten")],
    ["unknown flag", `${ok}&flags=ZZ`],
    ["window before 2021", ok.replace("2025-09-10", "2020-09-10")],
  ])("400 bad_request: %s", (_name, query) => {
    expect(parseActivityVesselsQuery(params(query), NOW)).toMatchObject({
      status: 400,
      code: "bad_request",
    });
  });

  test("6 windows are allowed; a window over 92 days is window_too_long", () => {
    const six = Array(6)
      .fill(0)
      .map(
        (_v, i) =>
          `${2020 + i + 1}-09-10T00:00:00Z/${2020 + i + 1}-10-29T00:00:00Z`,
      )
      .join(",");
    const q = parseActivityVesselsQuery(
      params(`windows=${six}&lat=62&lon=-6.8&radiusKm=10`),
      NOW,
    );
    expect("code" in q).toBe(false);
    expect(
      parseActivityVesselsQuery(
        params(ok.replace("2025-10-29", "2025-12-29")),
        NOW,
      ),
    ).toMatchObject({ status: 422, code: "window_too_long" });
  });
});

describe("buildActivityFeatureCollection", () => {
  test("folds per-vessel rows into weights per flag and type, minutes to 2 dp", () => {
    const fc = buildActivityFeatureCollection(
      [
        [
          -69,
          2067,
          3,
          [
            ["FO", 3, 40.004],
            ["FO", 3, 2.5],
            ["NO", 2, 7.256],
          ],
        ],
        [33, 1885, 1, [["IS", 28, 0.0166]]],
      ],
      {
        from: "2025-10-01T00:00:00.000Z",
        to: "2025-10-08T00:00:00.000Z",
        bbox: null,
        generatedAt: "2026-11-09T12:00:00.000Z",
        cached: false,
      },
    );
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-6.85, 62.025] },
      properties: {
        weights: { FO: { "3": 42.5 }, NO: { "2": 7.26 } },
        vessels: 3,
      },
    });
    expect(fc.features[1]?.properties.weights).toEqual({ IS: { "28": 0.02 } });
    expect(fc.meta).toEqual({
      from: "2025-10-01T00:00:00.000Z",
      to: "2025-10-08T00:00:00.000Z",
      bbox: null,
      grid: [0.1, 0.03],
      generatedAt: "2026-11-09T12:00:00.000Z",
      cached: false,
    });
  });

  test("a cell whose weights are all zero is omitted", () => {
    const fc = buildActivityFeatureCollection([[1, 1, 1, [["FO", 3, 0]]]], {
      from: "a",
      to: "b",
      bbox: null,
      generatedAt: "c",
      cached: false,
    });
    expect(fc.features).toHaveLength(0);
  });
});

describe("mergeHoverRows", () => {
  test("a vessel present in two windows counts once and its minutes add", () => {
    const merged = mergeHoverRows([
      {
        window: 0,
        vesselId: 1,
        name: "A",
        flag: "FO",
        typeId: 2,
        minutes: 100,
      },
      {
        window: 1,
        vesselId: 1,
        name: "A",
        flag: "FO",
        typeId: 2,
        minutes: 50.5,
      },
      {
        window: 1,
        vesselId: 2,
        name: null,
        flag: "NO",
        typeId: 3,
        minutes: 80,
      },
    ]);
    expect(merged).toEqual({
      vesselCount: 2,
      totalMinutes: 230.5,
      vessels: [
        { vesselId: 1, name: "A", flag: "FO", typeId: 2, minutes: 150.5 },
        { vesselId: 2, name: null, flag: "NO", typeId: 3, minutes: 80 },
      ],
    });
  });

  test("at most 50 rows, but count and total cover every vessel", () => {
    const rows = Array.from({ length: 73 }, (_v, i) => ({
      window: i % 2,
      vesselId: 1000 + i,
      name: `V${i}`,
      flag: "FO",
      typeId: 3,
      minutes: i + 1,
    }));
    const merged = mergeHoverRows(rows);
    expect(merged.vessels).toHaveLength(ACTIVITY_HOVER_MAX_ROWS);
    expect(ACTIVITY_HOVER_MAX_ROWS).toBe(50);
    expect(merged.vesselCount).toBe(73);
    // 1 + 2 + … + 73
    expect(merged.totalMinutes).toBe((73 * 74) / 2);
    // sorted by minutes desc: the biggest first, the 50th is 73 - 49 = 24
    expect(merged.vessels[0]?.minutes).toBe(73);
    expect(merged.vessels[49]?.minutes).toBe(24);
  });

  test("empty input is an empty card, not an error", () => {
    expect(mergeHoverRows([])).toEqual({
      vesselCount: 0,
      totalMinutes: 0,
      vessels: [],
    });
  });
});
