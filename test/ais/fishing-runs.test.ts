import { describe, expect, test } from "bun:test";
import {
  AIS_FISHING_MAX_KNOTS,
  AIS_FISHING_MIN_KNOTS,
  AIS_RUN_MAX_GAP_MINUTES,
  type AisRunFix,
  deriveFishingRuns,
  haversineKm,
  isFishingSpeed,
} from "../../src/ais/fishing-runs";

const MINUTE = 60_000;
const START = Date.parse("2026-05-27T20:00:00.000Z");

/** A fix `minutes` after START, at a position that barely moves. */
function fix(minutes: number, speed: number | null): AisRunFix {
  return {
    epochMs: START + minutes * MINUTE,
    latitude: 61 + minutes / 10_000,
    longitude: -6 + minutes / 10_000,
    speed,
  };
}

describe("isFishingSpeed — the band boundary, shared with fishfacts-fe", () => {
  // THE CROSS-REPO SEAM. fishfacts-fe carries the same predicate over the same
  // constants; this table is the contract between the two, and it is written
  // as a table so it can be diffed against the FE's by eye. A `>` where the
  // other side has `>=` passes both repos' own reviews and only ever shows up
  // as catch bubbles in the wrong place.
  const cases: Array<
    [label: string, speed: number | null | undefined, inBand: boolean]
  > = [
    ["0 kn — stopped", 0, false],
    ["0.29 kn — just under the floor", 0.29, false],
    ["0.3 kn — the floor itself, INCLUSIVE", 0.3, true],
    ["2.0 kn — mid-band", 2.0, true],
    ["5.5 kn — the ceiling itself, INCLUSIVE", 5.5, true],
    ["5.51 kn — just over the ceiling", 5.51, false],
    ["null — no speed reported", null, false],
    ["undefined — field absent", undefined, false],
    ["NaN — non-finite", Number.NaN, false],
    ["Infinity — non-finite", Number.POSITIVE_INFINITY, false],
  ];

  for (const [label, speed, inBand] of cases) {
    test(`${label} → ${inBand ? "in band" : "out of band"}`, () => {
      expect(isFishingSpeed(speed)).toBe(inBand);
    });
  }

  test("the band and gap are the numbers /api/ais/effort defaults to", () => {
    // Not configurable, by decision: ONE definition of "fishing", in code,
    // read by the effort endpoint and by this derivation.
    expect(AIS_FISHING_MIN_KNOTS).toBe(0.3);
    expect(AIS_FISHING_MAX_KNOTS).toBe(5.5);
    expect(AIS_RUN_MAX_GAP_MINUTES).toBe(30);
  });
});

describe("deriveFishingRuns", () => {
  test("a steady slow stretch is one run, anchored at its centroid", () => {
    const fixes = [
      fix(0, 8),
      fix(5, 2),
      fix(10, 3),
      fix(15, 2),
      fix(20, 2),
      fix(25, 9),
    ];
    const runs = deriveFishingRuns(fixes);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.fixCount).toBe(4);
    expect(run?.runStart).toBe(new Date(START + 5 * MINUTE).toISOString());
    expect(run?.runEnd).toBe(new Date(START + 20 * MINUTE).toISOString());
    expect(run?.avgKnots).toBe(2.3);
    expect(run?.latitude).toBeCloseTo(
      (61.0005 + 61.001 + 61.0015 + 61.002) / 4,
      9,
    );
  });

  test("EVERY qualifying run is returned, not just the last", () => {
    const fixes = [
      fix(0, 2),
      fix(8, 2),
      fix(16, 2),
      fix(24, 10), // steams away — first run ends here
      fix(40, 2),
      fix(50, 2),
      fix(60, 2),
    ];
    const runs = deriveFishingRuns(fixes);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.fixCount)).toEqual([3, 3]);
    // The FE spike keeps only the last run before the report; it must be the
    // last element here, or the two implementations disagree about which run
    // a single-anchor client shows.
    expect(runs.at(-1)?.runStart).toBe(
      new Date(START + 40 * MINUTE).toISOString(),
    );
  });

  test("a coverage gap over 30 minutes splits a run instead of bridging it", () => {
    const fixes = [
      fix(0, 2),
      fix(8, 2),
      fix(16, 2),
      // 31-minute AIS hole: the vessel may have gone anywhere.
      fix(47, 2),
      fix(55, 2),
      fix(63, 2),
    ];
    const runs = deriveFishingRuns(fixes);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.runEnd).toBe(new Date(START + 16 * MINUTE).toISOString());
    expect(runs[1]?.runStart).toBe(new Date(START + 47 * MINUTE).toISOString());
  });

  test("a gap of exactly 30 minutes stays inside one run", () => {
    const runs = deriveFishingRuns([fix(0, 2), fix(30, 2), fix(60, 2)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.fixCount).toBe(3);
  });

  test("a fix with no speed ends the run and never lands in the average", () => {
    const withUnknown = deriveFishingRuns([
      fix(0, 2),
      fix(8, 2),
      fix(16, 2),
      fix(24, null), // unknown — NOT zero, and not evidence of fishing
      fix(32, 2),
      fix(40, 2),
      fix(48, 2),
    ]);
    expect(withUnknown).toHaveLength(2);
    // Had the unknown been coerced to 0 kn it would have been out of band all
    // the same, so the SPLIT alone does not prove the point — the averages do:
    // both runs report a clean 2.0, with no zero dragging either down.
    expect(withUnknown.map((run) => run.avgKnots)).toEqual([2, 2]);
    expect(withUnknown.map((run) => run.fixCount)).toEqual([3, 3]);
  });

  test("an unknown speed splits the stretch rather than joining it", () => {
    // Two fishing fixes with an unknown between them are two runs, not one
    // run of three: we do not know the vessel was fishing in between, and a
    // centroid spanning the unknown would place a bubble on that guess.
    const runs = deriveFishingRuns([fix(0, 2), fix(16, null), fix(30, 2)]);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.fixCount)).toEqual([1, 1]);
    expect(runs.map((run) => run.avgKnots)).toEqual([2, 2]);
  });

  test("a SHORT in-band stretch is a run — speed is the whole rule", () => {
    // Gilli asked for a bubble at every stretch of track at fishing speed.
    // Two fixes four minutes apart used to be discarded as a momentary
    // slowdown, by rules that were ours and were never put to him.
    const runs = deriveFishingRuns([
      fix(0, 9),
      fix(10, 2),
      fix(14, 2),
      fix(20, 9),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.fixCount).toBe(2);
    expect(runs[0]?.runStart).toBe(new Date(START + 10 * MINUTE).toISOString());
    expect(runs[0]?.runEnd).toBe(new Date(START + 14 * MINUTE).toISOString());
  });

  test("even a single in-band fix between two fast ones is a run", () => {
    const runs = deriveFishingRuns([fix(0, 9), fix(10, 2), fix(20, 9)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.fixCount).toBe(1);
    expect(runs[0]?.avgKnots).toBe(2);
  });

  test("the gap rule survives — it is not a qualification rule", () => {
    // Everything else was dropped; this stays because a centroid computed
    // across an AIS blackout claims a position nothing was observed at. The
    // front end fades a track leg over a hole for the same reason.
    expect(deriveFishingRuns([fix(0, 2), fix(31, 2)])).toHaveLength(2);
    expect(deriveFishingRuns([fix(0, 2), fix(29, 2)])).toHaveLength(1);
  });

  test("out-of-order fixes are sorted before segmenting", () => {
    const runs = deriveFishingRuns([fix(16, 2), fix(0, 2), fix(8, 2)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runStart).toBe(new Date(START).toISOString());
  });

  test("no fixes, no runs", () => {
    expect(deriveFishingRuns([])).toEqual([]);
  });

  test("the same point is zero", () => {
    expect(haversineKm(61.5, -6.5, 61.5, -6.5)).toBe(0);
  });
});
