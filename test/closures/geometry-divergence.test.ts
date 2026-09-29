import { describe, expect, test } from "bun:test";
import type { OfficialClosure } from "../../src/closures/fiskeridir-wfs";
import { compareCase } from "../../src/closures/geometry-divergence";

function official(
  paragraph: number,
  name: string,
  vertices: { lat: number; lon: number }[],
  unreadableVertices = 0,
): OfficialClosure {
  return {
    jmNumber: "J-153-2026",
    paragraph,
    name,
    vertices,
    unreadableVertices,
  };
}

const BOX = [
  { lat: 70.75, lon: 29.75 },
  { lat: 70.8, lon: 29.75 },
  { lat: 70.8, lon: 29.9 },
  { lat: 70.75, lon: 29.9 },
];

describe("compareCase", () => {
  test("silent when our vertices match the authority's list", () => {
    const result = compareCase(
      "J-153-2026",
      [official(1, "Finnskallen", BOX)],
      [{ name: "§ 1 Finnskallen i Finnmark", points: BOX }],
    );
    expect(result).toBeNull();
  });

  test("reports a vertex the authority places elsewhere", () => {
    // J-153-2026 § 32: the statute prints `Øst 007 grader 3,.000 minutter`,
    // which reads as 3.0 and lands the corner 29 km from where the authority's
    // own list puts it (`7 38,000`).
    const moved = [{ lat: BOX[0].lat, lon: 7.05 }, ...BOX.slice(1)];
    const result = compareCase(
      "J-153-2026",
      [official(32, "Skatebåen", BOX)],
      [{ name: "§ 32 Skatebåen i Møre og Romsdal", points: moved }],
    );
    expect(result?.areas).toHaveLength(1);
    expect(result?.areas[0].kind).toBe("position");
    expect(result?.areas[0].paragraph).toBe(32);
  });

  test("a missing closure does not shift every later pair onto a false one", () => {
    // The reason pairing is by § rather than by position: § 2 absent used to
    // slide §§ 3..n onto the previous paragraph's vertices, and each shifted
    // pair reported as a position difference hundreds of kilometres wide —
    // burying the one real finding under a screenful of derived ones.
    const far = [{ lat: 63.4, lon: 7.6 }];
    const result = compareCase(
      "J-153-2026",
      [official(1, "A", BOX), official(2, "B", far), official(3, "C", BOX)],
      [
        { name: "§ 1 A", points: BOX },
        { name: "§ 3 C", points: BOX },
      ],
    );
    expect(result?.areas).toHaveLength(1);
    expect(result?.areas[0].kind).toBe("missing-area");
    expect(result?.areas[0].paragraph).toBe(2);
  });

  test("an area with no § number is reported, not allowed to block § pairing", () => {
    const result = compareCase(
      "J-153-2026",
      [official(1, "A", BOX)],
      [
        { name: "§ 1 A", points: BOX },
        { name: null, points: [{ lat: 71, lon: 25 }] },
      ],
    );
    expect(result?.areas).toHaveLength(1);
    expect(result?.areas[0].kind).toBe("unnumbered-area");
  });

  test("differing vertex counts are a count finding, not a position one", () => {
    // §§ 1 and 6 of the seinot forskrift are bounded by open lines plus the
    // coastline, so the authority's list carries vertices the statute never
    // prints. That is a real difference and not a wrong coordinate.
    const result = compareCase(
      "J-153-2026",
      [official(1, "Lafjorden", BOX)],
      [{ name: "§ 1 Lafjorden", points: BOX.slice(0, 2) }],
    );
    expect(result?.areas[0].kind).toBe("vertex-count");
  });

  test("falls back to counting when neither side numbers its areas", () => {
    const result = compareCase(
      "J-155-2026",
      [
        { ...official(1, "Varanger", BOX), paragraph: null },
        { ...official(2, "Kjøtta", BOX), paragraph: null },
      ],
      [{ name: "Det er forbudt å fiske på Varanger…", points: BOX }],
    );
    expect(result?.areaCountDetail).toContain("2");
    expect(result?.areas).toEqual([]);
  });

  test("flags vertices the authority's own list could not be read from", () => {
    const result = compareCase(
      "J-146-2026",
      [official(1, "Røstbanken", BOX, 2)],
      [{ name: "§ 1 Røstbanken", points: BOX }],
    );
    expect(result?.areas[0].kind).toBe("unreadable-source");
  });
});

describe("compareCase — a § the reader split into several areas", () => {
  test("several areas under one § are compared against the authority together", () => {
    // The reader splits at every lead-in and does not judge continuation, so
    // § 1 of the seinot forskrift arrives as two boundary runs. Treating the
    // repeated § as unpairable would drop the announcement onto positional
    // pairing and lose every real finding in it.
    const result = compareCase(
      "J-153-2026",
      [official(1, "Lafjorden", BOX)],
      [
        { name: "§ 1 Lafjorden", points: BOX.slice(0, 2) },
        { name: "§ 1 Lafjorden", points: BOX.slice(2) },
      ],
    );
    expect(result).toBeNull();
  });

  test("a real finding elsewhere survives a § that split", () => {
    const moved = [{ lat: BOX[0].lat, lon: 7.05 }, ...BOX.slice(1)];
    const result = compareCase(
      "J-153-2026",
      [official(1, "Lafjorden", BOX), official(32, "Skatebåen", BOX)],
      [
        { name: "§ 1 Lafjorden", points: BOX.slice(0, 2) },
        { name: "§ 1 Lafjorden", points: BOX.slice(2) },
        { name: "§ 32 Skatebåen", points: moved },
      ],
    );
    expect(result?.areas).toHaveLength(1);
    expect(result?.areas[0].paragraph).toBe(32);
    expect(result?.areas[0].kind).toBe("position");
  });
});
