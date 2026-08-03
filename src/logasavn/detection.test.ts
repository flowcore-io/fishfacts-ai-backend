import { describe, expect, test } from "bun:test";
import {
  COORDINATE_TEXT_DETECTOR_ID,
  type CoordinateDetector,
  type DetectableFragment,
  HAS_COORDINATES_TAG_DETECTOR_ID,
  activeDetectors,
  coordinateTextDetector,
  detectCoordinates,
  detectorsDisagree,
  hasCoordinatesTagDetector,
} from "./detection";

const DETECTORS = [coordinateTextDetector, hasCoordinatesTagDetector];

function fragment(overrides: Partial<DetectableFragment> = {}) {
  return {
    id: "fragment-1",
    body: "Prose with no geometry in it whatsoever.",
    tags: [],
    ...overrides,
  };
}

// Kunngerð 35/2026 § 2 — Føroyabanki, in degrees-minutes-seconds.
const WITH_COORDINATES = fragment({
  body: `- **1)**60°57'20"N - 07°57'00"V
- **2)**61°03'00"N - 07°57'00"V`,
});

describe("coordinateTextDetector", () => {
  test("counts every coordinate-like construct it can see", () => {
    const verdict = coordinateTextDetector.detect(WITH_COORDINATES);

    expect(verdict.detectorId).toBe(COORDINATE_TEXT_DETECTOR_ID);
    expect(verdict.candidate).toBe(true);
    expect(verdict.signal).toBe(4); // two vertices, each a lat + a lon
  });

  test("a bearing origin is not a coordinate", () => {
    // `315° rættvísandi úr Barðinum` — a degree sign with no hemisphere.
    const verdict = coordinateTextDetector.detect(
      fragment({ body: "millum 315° rættvísandi úr Barðinum, og" }),
    );

    expect(verdict.candidate).toBe(false);
    expect(verdict.signal).toBe(0);
  });
});

describe("hasCoordinatesTagDetector", () => {
  test("fires on either spelling of the upstream tag", () => {
    for (const tag of ["has_coordinates", "has-coordinates"]) {
      expect(
        hasCoordinatesTagDetector.detect(fragment({ tags: [tag] })).candidate,
      ).toBe(true);
    }
  });

  test("does not fire on an unrelated tag", () => {
    expect(
      hasCoordinatesTagDetector.detect(
        fragment({ tags: ["authority:uttanrikis-og-fiskimalaradid"] }),
      ).candidate,
    ).toBe(false);
  });
});

describe("detectCoordinates", () => {
  test("takes the union, so either reader alone makes a candidate", () => {
    const taggedOnly = detectCoordinates(
      DETECTORS,
      fragment({ tags: ["has_coordinates"] }),
    );

    expect(taggedOnly.candidate).toBe(true);
    expect(taggedOnly.signals[COORDINATE_TEXT_DETECTOR_ID]).toBe(0);
    expect(taggedOnly.signals[HAS_COORDINATES_TAG_DETECTOR_ID]).toBe(1);
  });

  test("a reader the other contradicts is recorded as a disagreement", () => {
    // The dangerous shape: their tagger sees geometry our tokenizer cannot.
    const detection = detectCoordinates(
      DETECTORS,
      fragment({ tags: ["has_coordinates"] }),
    );

    expect(detection.disagreement).toBe(true);
  });

  test("agreement on both sides is not a disagreement", () => {
    const both = detectCoordinates(DETECTORS, {
      ...WITH_COORDINATES,
      tags: ["has_coordinates"],
    });
    const neither = detectCoordinates(DETECTORS, fragment());

    expect(both.candidate).toBe(true);
    expect(both.disagreement).toBe(false);
    expect(neither.candidate).toBe(false);
    expect(neither.disagreement).toBe(false);
  });

  test("one reader never disagrees with itself", () => {
    expect(
      detectCoordinates([coordinateTextDetector], WITH_COORDINATES)
        .disagreement,
    ).toBe(false);
    expect(detectorsDisagree([])).toBe(false);
  });
});

describe("activeDetectors", () => {
  // The tag has not shipped upstream yet. Left in the set it would contradict
  // the text reader on every candidate and stamp the whole queue
  // `crosscheck_disagreement` — burying the real disagreements it exists for.
  test("a detector that fires on nothing corpus-wide is dropped as inert", () => {
    const corpus = [WITH_COORDINATES, fragment({ id: "fragment-2" })];

    const { active, inert } = activeDetectors(DETECTORS, corpus);

    expect(active.map((d) => d.id)).toEqual([COORDINATE_TEXT_DETECTOR_ID]);
    expect(inert).toEqual([HAS_COORDINATES_TAG_DETECTOR_ID]);
  });

  test("the cross-check turns itself on the day the tag appears", () => {
    const corpus = [
      WITH_COORDINATES,
      fragment({ id: "fragment-2", tags: ["has_coordinates"] }),
    ];

    const { active, inert } = activeDetectors(DETECTORS, corpus);

    expect(active.map((d) => d.id)).toEqual([
      COORDINATE_TEXT_DETECTOR_ID,
      HAS_COORDINATES_TAG_DETECTOR_ID,
    ]);
    expect(inert).toEqual([]);
  });

  test("an empty corpus silences nothing", () => {
    // Otherwise a failed fetch reads as "the detectors are all gone" — and the
    // sweep would then have no reader at all rather than no input.
    const { active, inert } = activeDetectors(DETECTORS, []);

    expect(active).toHaveLength(2);
    expect(inert).toEqual([]);
  });

  test("a detector set is never emptied, whatever the corpus looks like", () => {
    const blind: CoordinateDetector = {
      id: "blind",
      detect: () => ({ detectorId: "blind", candidate: false, signal: 0 }),
    };

    const { active } = activeDetectors([blind], [WITH_COORDINATES]);

    expect(active.map((d) => d.id)).toEqual(["blind"]);
  });
});
