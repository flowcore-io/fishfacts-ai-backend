import { expect, test } from "bun:test";
import { withinOriginalSegmentStrip } from "../../src/regulations/shoreline-witness";
test("one unchanged segment bounds the whole numeric overlap, not independently nearest vertices or a zero area heuristic", () => {
  const segment: [[number, number], [number, number]] = [
    [25.3354117, 70.9801603],
    [25.3362983, 70.9799788],
  ];
  expect(withinOriginalSegmentStrip([segment[0], segment[1]], segment)).toBe(
    true,
  );
  expect(withinOriginalSegmentStrip([[25.3358, 70.979]], segment)).toBe(false);
  expect(
    withinOriginalSegmentStrip([[25.3353, 70.98018322872105]], segment),
  ).toBe(false);
  expect(
    withinOriginalSegmentStrip(
      [[0, 0]],
      [
        [0, 0],
        [0, 0],
      ],
    ),
  ).toBe(false);
  expect(
    withinOriginalSegmentStrip(
      [
        [0.5, 1e-13],
        [0.8, -1e-13],
        [0.5, 1e-13],
      ],
      [
        [0, 0],
        [1, 0],
      ],
    ),
  ).toBe(true);
  expect(
    withinOriginalSegmentStrip(
      [[0.5, 1.01e-12]],
      [
        [0, 0],
        [1, 0],
      ],
    ),
  ).toBe(false);
});
