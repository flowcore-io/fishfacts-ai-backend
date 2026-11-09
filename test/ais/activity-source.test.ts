import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_DEFAULT_FLAGS,
  ACTIVITY_DEFAULT_TYPES,
  activityCellCentre,
  activityCellIndex,
} from "../../src/ais/activity";
import {
  ACTIVITY_EARTH_RADIUS_KM,
  REGISTRY_CTE,
  buildActivityCellsQuery,
  buildActivityHoverQuery,
  hoverPrefilter,
  speedBandGroups,
} from "../../src/ais/activity-source";

const FLAGS = [...ACTIVITY_DEFAULT_FLAGS].sort();
const TYPES = [...ACTIVITY_DEFAULT_TYPES].sort((a, b) => a - b);

// What reaches the production ClickHouse — guarded the way test/ais guards
// /density and /effort, since none of it can be checked without a live server.
describe("buildActivityCellsQuery", () => {
  const built = buildActivityCellsQuery({
    from: "2025-09-10T00:00:00.000Z",
    to: "2025-10-29T00:00:00.000Z",
    bbox: [-30, 55, 35, 80],
    flags: FLAGS,
    types: TYPES,
  });

  test("time-weighted: credits the gap since the previous fix, capped at 30 min, never counts fixes", () => {
    expect(built.query).toContain(
      "if(gap_s > 0 AND gap_s <= {maxGap:UInt32}, gap_s, 0)",
    );
    expect(built.query_params.maxGap).toBe(1800);
    expect(built.query).toContain("lagInFrame(event_time, 1, event_time)");
    expect(built.query).toContain("PARTITION BY vessel_id ORDER BY event_time");
    // count() is only the per-cell distinct vessel count, never a weight
    expect(built.query).not.toMatch(/count\(\)\s*\/|countIf/);
    expect(built.query).toMatch(/count\(\) AS vessels/);
  });

  test("dedupes to one fix per (vessel, event_time) before the lag", () => {
    expect(built.query).toContain("GROUP BY vessel_id, event_time");
  });

  test("snaps to the FishFacts lattice with floor(), as activityCellIndex does", () => {
    expect(built.query).toContain("toInt32(floor(lo / {gridLon:Float64}))");
    expect(built.query).toContain("toInt32(floor(la / {gridLat:Float64}))");
    expect(built.query_params.gridLon).toBe(0.1);
    expect(built.query_params.gridLat).toBe(0.03);
  });

  test("joins the latest registry snapshot, cut to the requested flags and types", () => {
    expect(built.query).toContain(REGISTRY_CTE);
    expect(REGISTRY_CTE).toContain(
      "snapshot = (SELECT max(snapshot) FROM ais_vessel_registry)",
    );
    expect(built.query_params.flags).toEqual(FLAGS);
    expect(built.query_params.types).toEqual(TYPES);
  });

  test("the speed band is per type and bound as parameters, never inlined", () => {
    expect(built.query).toContain("{band0Min:Float64}");
    expect(built.query).not.toMatch(/speed >= \d/);
    const groups = speedBandGroups(TYPES);
    groups.forEach((g, i) => {
      expect(built.query_params[`band${i}Min`]).toBe(g.min);
      expect(built.query_params[`band${i}Max`]).toBe(g.max);
      expect(built.query_params[`band${i}Types`]).toEqual(g.types);
    });
  });

  test("no vessel id is ever inlined into the SQL", () => {
    expect(built.query).not.toMatch(/IN \(\d/);
    expect(built.query.length).toBeLessThan(4000);
  });

  test("bbox is a bound filter, and absent for a global window", () => {
    expect(built.query_params).toMatchObject({
      minLon: -30,
      minLat: 55,
      maxLon: 35,
      maxLat: 80,
    });
    const global = buildActivityCellsQuery({
      from: "2025-10-01T00:00:00.000Z",
      to: "2025-10-31T00:00:00.000Z",
      bbox: null,
      flags: FLAGS,
      types: TYPES,
    });
    expect(global.query).not.toContain("{minLat:Float64}");
    expect(global.query).not.toContain(
      "vessel_id IN (\n        SELECT DISTINCT",
    );
    expect(global.query_params.minLat).toBeUndefined();
    expect(global.query_params.from).toBe("2025-10-01 00:00:00.000");
  });
});

describe("buildActivityCellsQuery, regional", () => {
  const built = buildActivityCellsQuery({
    from: "2025-09-10T00:00:00.000Z",
    to: "2025-10-29T00:00:00.000Z",
    bbox: [-30, 55, 35, 80],
    flags: FLAGS,
    types: TYPES,
  });

  test("the bbox picks candidates and cuts cells; it never clips fixes before the lag (A3)", () => {
    const fx = built.query.slice(
      built.query.indexOf("fx AS ("),
      built.query.indexOf("credited AS ("),
    );
    // inside fx the bbox appears only in the candidate subquery
    expect(fx).toContain("vessel_id IN (\n        SELECT DISTINCT vessel_id");
    const outsideCandidates = fx.replace(/vessel_id IN \([\s\S]*?\)\n/, "");
    expect(outsideCandidates).not.toContain("{minLat:Float64}");
    const lag = built.query.indexOf("lagInFrame");
    const cellCut = built.query.indexOf("WHERE ix >= toInt32(floor({minLon");
    expect(cellCut).toBeGreaterThan(lag);
  });
});

describe("speedBandGroups", () => {
  test("the FE's 9 types fall into three bands", () => {
    expect(speedBandGroups(TYPES)).toEqual([
      { min: 0.3, max: 7.5, types: [2, 28, 29] },
      { min: 1, max: 5, types: [3, 4, 5, 8, 10] },
      { min: 0.3, max: 5, types: [6] },
    ]);
  });
  test("an unknown type is a programming error, not an empty band", () => {
    expect(() => speedBandGroups([9])).toThrow();
  });
});

describe("buildActivityHoverQuery", () => {
  const built = buildActivityHoverQuery({
    windows: [
      { from: "2024-09-10T00:00:00.000Z", to: "2024-10-29T00:00:00.000Z" },
      { from: "2025-09-10T00:00:00.000Z", to: "2025-10-29T00:00:00.000Z" },
    ],
    lat: 62.235,
    lon: -4.25,
    radiusKm: 15,
    flags: FLAGS,
    types: TYPES,
  });

  test("one bound pair per window, and the lag never bridges two windows", () => {
    expect(built.query_params.w0f).toBe("2024-09-10 00:00:00.000");
    expect(built.query_params.w1t).toBe("2025-10-29 00:00:00.000");
    expect(built.query).toContain(
      "PARTITION BY vessel_id, w ORDER BY event_time",
    );
  });

  test("the area rule is the CELL CENTRE within the radius, by haversine on turf's earth", () => {
    expect(built.query).toContain(
      "round((toInt32(floor(lo / {gridLon:Float64})) + 0.5) * {gridLon:Float64}, 3) AS clon",
    );
    expect(built.query).toContain("<= {radiusKm:Float64}");
    expect(built.query_params.earthKm).toBe(ACTIVITY_EARTH_RADIUS_KM);
    expect(ACTIVITY_EARTH_RADIUS_KM).toBe(6371.0088);
  });

  test("the gap is computed over the vessel's whole track before the area cut", () => {
    const lag = built.query.indexOf("lagInFrame");
    const cut = built.query.indexOf("<= {radiusKm:Float64}");
    expect(lag).toBeGreaterThan(-1);
    expect(cut).toBeGreaterThan(lag);
  });

  test("fishing types only: the registry cut applies to the hover too", () => {
    expect(built.query).toContain(REGISTRY_CTE);
    expect(built.query_params.types).toEqual(TYPES);
  });
});

describe("hoverPrefilter", () => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const haversineKm = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ) => {
    const a =
      Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return 2 * ACTIVITY_EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  };
  /** Longitude wrapped into [-180, 180). */
  const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

  /** Walk a fine grid of fixes; any whose cell centre is within r must pass the prefilter. */
  function expectHoldsEveryCentreInside(lat: number, lon: number, r: number) {
    const area = hoverPrefilter(lat, lon, r);
    let inside = 0;
    for (let la = lat - 0.4; la <= lat + 0.4; la += 0.007) {
      for (let step = -0.8; step <= 0.8; step += 0.013) {
        const lo = wrap(lon + step);
        const [cx, cy] = activityCellCentre(...activityCellIndex(lo, la));
        if (haversineKm(lat, lon, cy, cx) > r) continue;
        inside++;
        const passes =
          la >= area.minLat &&
          la <= area.maxLat &&
          area.lonRanges.some(([min, max]) => lo >= min && lo <= max);
        expect(passes).toBe(true);
      }
    }
    expect(inside).toBeGreaterThan(0);
  }

  test("holds every fix whose cell centre can be inside the circle", () => {
    expectHoldsEveryCentreInside(62.235, -4.25, 15);
    expect(hoverPrefilter(62.235, -4.25, 15).lonRanges).toHaveLength(1);
  });

  test("a circle over the antimeridian from the east side wraps to the west side", () => {
    const area = hoverPrefilter(-40.005, 179.95, 25);
    expect(area.lonRanges).toHaveLength(2);
    expect(area.lonRanges[0]?.[1]).toBe(180);
    expect(area.lonRanges[1]?.[0]).toBe(-180);
    expectHoldsEveryCentreInside(-40.005, 179.95, 25);
  });

  test("a circle over the antimeridian from the west side wraps to the east side", () => {
    const area = hoverPrefilter(-40.005, -179.95, 25);
    expect(area.lonRanges).toHaveLength(2);
    expect(area.lonRanges[0]?.[0]).toBe(-180);
    expect(area.lonRanges[1]?.[1]).toBe(180);
    expectHoldsEveryCentreInside(-40.005, -179.95, 25);
  });

  test("near a pole the longitude filter opens fully", () => {
    const area = hoverPrefilter(89.9, 10, 50);
    expect(area.lonRanges).toEqual([[-180, 180]]);
    expect(area.maxLat).toBe(90);
  });
});
