import { describe, expect, test } from "bun:test";
import {
  parseOfficialCoordinate,
  parseOfficialVertices,
} from "../../src/closures/fiskeridir-wfs";

describe("parseOfficialCoordinate", () => {
  test("bare degrees and decimal minutes, comma decimal", () => {
    // The common form, and the one the statute itself prints.
    expect(parseOfficialCoordinate("70 45,000")).toBeCloseTo(70.75, 6);
    expect(parseOfficialCoordinate("7 38,000")).toBeCloseTo(7 + 38 / 60, 6);
  });

  test("degree sign with a hemisphere letter", () => {
    // J-146-2026 § 1 is written this way while § 2 of the same announcement
    // uses the bare form — both have to read.
    expect(parseOfficialCoordinate("68° 11.6000N")).toBeCloseTo(
      68 + 11.6 / 60,
      6,
    );
    expect(parseOfficialCoordinate("010° 44.0000E")).toBeCloseTo(
      10 + 44 / 60,
      6,
    );
  });

  test("southern and western hemispheres are negative", () => {
    expect(parseOfficialCoordinate("10° 30.0000S")).toBeCloseTo(-10.5, 6);
    expect(parseOfficialCoordinate("010° 30.0000W")).toBeCloseTo(-10.5, 6);
  });

  test("rejects what it cannot read rather than guessing", () => {
    // A guessed value is worse than a gap: the cross-check exists to say our
    // reading and the authority's disagree, and a silent fallback would make
    // them agree wrongly.
    expect(parseOfficialCoordinate("70 75,000")).toBeNull();
    expect(parseOfficialCoordinate("not a coordinate")).toBeNull();
    expect(parseOfficialCoordinate("")).toBeNull();
  });
});

describe("parseOfficialVertices", () => {
  test("reads the authority's vertex list in order", () => {
    const raw = JSON.stringify([
      { lat: "70 45,000", lon: "29 45,000", show: true, ref: "1" },
      { lat: "70 49,000", lon: "29 45,000", show: true, ref: "2" },
    ]);
    const { vertices, unreadable } = parseOfficialVertices(raw);
    expect(unreadable).toBe(0);
    expect(vertices).toHaveLength(2);
    expect(vertices[0].lat).toBeCloseTo(70.75, 6);
    expect(vertices[1].lat).toBeCloseTo(70 + 49 / 60, 6);
  });

  test("counts unreadable entries instead of dropping them silently", () => {
    const raw = JSON.stringify([
      { lat: "70 45,000", lon: "29 45,000" },
      { lat: "garbage", lon: "29 45,000" },
    ]);
    const { vertices, unreadable } = parseOfficialVertices(raw);
    expect(vertices).toHaveLength(1);
    expect(unreadable).toBe(1);
  });

  test("a missing or malformed field is empty, not a throw", () => {
    expect(parseOfficialVertices(null).vertices).toEqual([]);
    expect(parseOfficialVertices("{not json").vertices).toEqual([]);
    expect(parseOfficialVertices('"a string"').vertices).toEqual([]);
  });
});
