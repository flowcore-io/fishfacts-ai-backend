import { describe, expect, test } from "bun:test";
import type { RingPoint } from "./vorn-ring";
import {
  dropClosingRepeat,
  dropClosingRepeats,
  normalizeVornAreas,
  normalizeVornRing,
  ringSelfIntersects,
} from "./vorn-ring";

// DDMM (deg + arc-minutes) → decimal, W longitudes negative. Matches the raw
// {lat, lon} points the Vørn scraper emits onto the announcement event.
const p = (
  latD: number,
  latM: number,
  lonD: number,
  lonM: number,
): RingPoint => ({
  lat: latD + latM / 60,
  lon: -(lonD + lonM / 60),
});

// The typo'd nr. 14/2026 ring, as Vørn published it: the closing "6104 N –
// 0700 W" was fat-fingered as "6014 N", so the ring never closes and crosses
// itself. Shared by the repair tests and the as-written tests, which is the
// point — the same input, two deliberately different answers.
const P1 = p(61, 4, 7, 0);
const NR14_TYPO = p(60, 14, 7, 0);
const NR14_RAW = [
  P1,
  p(60, 57, 7, 6),
  p(60, 45, 7, 0),
  p(60, 39, 6, 54),
  p(60, 45, 6, 36),
  NR14_TYPO,
];

describe("dropClosingRepeat", () => {
  test("drops the repeated closing vertex — the pure-convention cleanup", () => {
    const ring = [p(62, 39, 5, 51), p(62, 30, 6, 0), p(62, 39, 5, 51)];
    expect(dropClosingRepeat(ring)).toEqual([
      p(62, 39, 5, 51),
      p(62, 30, 6, 0),
    ]);
  });

  test("keeps a typo'd closing vertex the repair would have removed", () => {
    // The approval queue's whole reason for existing: the admin has to see the
    // spike, so the correction is a reviewed revision rather than a silent one.
    expect(dropClosingRepeat(NR14_RAW)).toEqual(NR14_RAW);
    expect(normalizeVornRing(NR14_RAW).points).toHaveLength(5);
  });

  test("leaves a ring that does not close by repeat alone", () => {
    const ring = [p(62, 0, 7, 0), p(62, 0, 6, 30), p(61, 40, 6, 45)];
    expect(dropClosingRepeat(ring)).toEqual(ring);
  });

  test("never empties a degenerate ring", () => {
    const point = p(62, 0, 7, 0);
    expect(dropClosingRepeat([point, point])).toHaveLength(2);
    expect(dropClosingRepeat([point])).toHaveLength(1);
    expect(dropClosingRepeat([])).toHaveLength(0);
  });

  test("does not mutate its input", () => {
    const ring = [p(62, 39, 5, 51), p(62, 30, 6, 0), p(62, 39, 5, 51)];
    dropClosingRepeat(ring);
    expect(ring).toHaveLength(3);
  });
});

describe("dropClosingRepeats", () => {
  test("applies per area and preserves the other fields", () => {
    const areas = dropClosingRepeats([
      {
        name: "A",
        points: [p(62, 39, 5, 51), p(62, 30, 6, 0), p(62, 39, 5, 51)],
      },
      { name: "nr14", points: NR14_RAW },
    ]);
    expect(areas[0].points).toHaveLength(2);
    expect(areas[0].name).toBe("A");
    expect(areas[1].points).toEqual(NR14_RAW); // as written, spike and all
  });
});

describe("normalizeVornRing", () => {
  test("drops the repeated closing vertex on a well-formed ring (no warning)", () => {
    // nr 10/11/12/13 convention: Vørn repeats P1 as the last point to close.
    const ring = [
      p(62, 39, 5, 51),
      p(62, 30, 6, 0),
      p(62, 20, 5, 40),
      p(62, 39, 5, 51),
    ];
    const { points, warning } = normalizeVornRing(ring);
    expect(points).toHaveLength(3);
    expect(warning).toBeNull();
  });

  test("repairs veiðibann nr. 14/2026's typo'd closing vertex", () => {
    // Live source lists 6 points; the last, 6014 N – 0700 W, is a digit
    // transposition of the first, 6104 N – 0700 W (the intended closing repeat).
    const p1 = p(61, 4, 7, 0);
    const p5 = p(60, 45, 6, 36);
    const raw = [
      p1,
      p(60, 57, 7, 6),
      p(60, 45, 7, 0),
      p(60, 39, 6, 54),
      p5,
      p(60, 14, 7, 0), // ← typo: should have been 6104 N (== p1)
    ];
    expect(ringSelfIntersects(raw)).toBe(true);

    const { points, warning } = normalizeVornRing(raw);
    expect(points).toHaveLength(5);
    expect(points.at(-1)).toEqual(p5);
    expect(ringSelfIntersects(points)).toBe(false);
    expect(warning?.code).toBe("typo-unclosed-ring-repaired");
    expect(warning?.droppedPoint).toEqual(p(60, 14, 7, 0));
  });

  test("leaves a genuine unclosed but simple ring untouched (no warning)", () => {
    const ring = [p(62, 0, 7, 0), p(62, 0, 6, 30), p(61, 40, 6, 45)];
    const { points, warning } = normalizeVornRing(ring);
    expect(points).toHaveLength(3);
    expect(warning).toBeNull();
  });

  test("leaves a ≥4-vertex unclosed but simple ring untouched (no warning)", () => {
    // The conservative guarantee rests on the ≥4-vertex case: a simple ring
    // that does not repeat P1 must pass through, since ringSelfIntersects only
    // short-circuits below 4 vertices. Simple quadrilateral, unclosed.
    const ring = [
      p(62, 0, 7, 0),
      p(62, 0, 6, 30),
      p(61, 50, 6, 30),
      p(61, 50, 7, 0),
    ];
    expect(ringSelfIntersects(ring)).toBe(false);
    const { points, warning } = normalizeVornRing(ring);
    expect(points).toHaveLength(4);
    expect(warning).toBeNull();
  });
});

describe("normalizeVornAreas", () => {
  test("normalises every area and collects warnings", () => {
    const good = {
      name: "A",
      points: [
        p(62, 39, 5, 51),
        p(62, 30, 6, 0),
        p(62, 20, 5, 40),
        p(62, 39, 5, 51),
      ],
    };
    const broken = {
      name: "nr14",
      points: [
        p(61, 4, 7, 0),
        p(60, 57, 7, 6),
        p(60, 45, 7, 0),
        p(60, 39, 6, 54),
        p(60, 45, 6, 36),
        p(60, 14, 7, 0),
      ],
    };
    const { areas, warnings } = normalizeVornAreas([good, broken]);
    expect(areas[0].points).toHaveLength(3); // closing dup dropped
    expect(areas[0].name).toBe("A"); // other fields preserved
    expect(areas[1].points).toHaveLength(5); // typo vertex repaired
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("typo-unclosed-ring-repaired");
  });
});
