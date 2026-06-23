import { describe, expect, test } from "bun:test";
import { geometryToWkt } from "../../src/gebco/ingester";

describe("geometryToWkt", () => {
  test("single point → POINT with centroid + bbox", () => {
    const r = geometryToWkt("point", { points: [[-7.25, 60]] });
    expect(r).not.toBeNull();
    expect(r?.wkt).toBe("POINT(-7.25 60)");
    expect(r?.centroid).toEqual([-7.25, 60]);
    expect(r?.bbox).toEqual([-7.25, 60, -7.25, 60]);
  });

  test("multi-point → MULTIPOINT, centroid is the mean", () => {
    const r = geometryToWkt("point", {
      points: [
        [0, 0],
        [2, 4],
      ],
    });
    expect(r?.wkt).toBe("MULTIPOINT((0 0), (2 4))");
    expect(r?.centroid).toEqual([1, 2]);
    expect(r?.bbox).toEqual([0, 0, 2, 4]);
  });

  test("polyline → MULTILINESTRING over all paths", () => {
    const r = geometryToWkt("line", {
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    });
    expect(r?.wkt).toBe("MULTILINESTRING((0 0, 1 1))");
  });

  test("polygon ring is auto-closed", () => {
    const r = geometryToWkt("polygon", {
      rings: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
      ],
    });
    // first vertex appended to close the ring
    expect(r?.wkt).toBe("MULTIPOLYGON(((0 0, 2 0, 2 2, 0 2, 0 0)))");
  });

  test("already-closed polygon ring kept as-is", () => {
    const r = geometryToWkt("polygon", {
      rings: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 0],
        ],
      ],
    });
    expect(r?.wkt).toBe("MULTIPOLYGON(((0 0, 2 0, 2 2, 0 0)))");
  });

  test("non-finite / empty geometry → null", () => {
    expect(geometryToWkt("point", { points: [] })).toBeNull();
    expect(geometryToWkt("point", undefined)).toBeNull();
    expect(geometryToWkt("line", { paths: [[[0, 0]]] })).toBeNull(); // < 2 pts
    expect(
      geometryToWkt("polygon", {
        rings: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toBeNull(); // < 4 pts after close
    expect(geometryToWkt("point", { points: [[Number.NaN, 5]] })).toBeNull();
  });

  test("filters non-finite vertices out of a path", () => {
    const r = geometryToWkt("line", {
      paths: [
        [
          [0, 0],
          [Number.NaN, 9],
          [1, 1],
        ],
      ],
    });
    expect(r?.wkt).toBe("MULTILINESTRING((0 0, 1 1))");
  });
});
