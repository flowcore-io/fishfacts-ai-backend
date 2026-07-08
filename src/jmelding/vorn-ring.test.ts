import { describe, expect, test } from "bun:test";
import type { RingPoint } from "./vorn-ring";
import {
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
