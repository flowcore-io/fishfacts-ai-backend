import { describe, expect, test } from "bun:test";
import {
  areasToFeatureCollection,
  areasToWkt,
  parseJmeldingGeo,
} from "../../src/jmelding/geo-parser";

describe("parseJmeldingGeo", () => {
  test("returns empty for null/empty input", () => {
    expect(parseJmeldingGeo(null)).toEqual({
      areas: [],
      bbox: null,
      hasGeo: false,
    });
    expect(parseJmeldingGeo("")).toEqual({
      areas: [],
      bbox: null,
      hasGeo: false,
    });
  });

  test("J-67-2026 — long-form DMM with multiple named polygons", () => {
    const sample = `
Det er det forbudt å fiske med snurrevad på Steinryggen i Finnmark avgrenset av rette linjer mellom følgende posisjoner:

1. Nord 71 grader 10,000 minutter. Øst 024 grader 53,000 minutter.
2. Nord 71 grader 11,600 minutter. Øst 024 grader 53,700 minutter.
3. Nord 71 grader 12,600 minutter. Øst 024 grader 58,400 minutter.

Det er forbudt å fiske med snurrevad med mindre maskevidde en 130 mm ved Kongsfjorden i Finnmark, avgrenset av rette linjer mellom følgende posisjoner:

1. Nord 70 grader 49,7 minutter. Øst 029 grader 22,8 minutter.
2. Nord 70 grader 52,8 minutter. Øst 029 grader 31,6 minutter.
`;
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    expect(result.areas.length).toBeGreaterThanOrEqual(1);
    const allPoints = result.areas.flatMap((a) => a.points);
    expect(allPoints.length).toBe(5);
    expect(allPoints[0].lat).toBeCloseTo(71 + 10 / 60, 4);
    expect(allPoints[0].lon).toBeCloseTo(24 + 53 / 60, 4);
    expect(result.bbox?.[0]).toBeLessThan(result.bbox?.[2] ?? 0);
    expect(result.bbox?.[1]).toBeLessThan(result.bbox?.[3] ?? 0);
  });

  test("J-67-2026 — handles period decimal typo (42.5 instead of 42,5)", () => {
    const sample =
      "1. Nord 70 grader 42.5 minutter. Øst 030 grader 04.6 minutter.";
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    expect(result.areas[0].points[0].lat).toBeCloseTo(70 + 42.5 / 60, 4);
    expect(result.areas[0].points[0].lon).toBeCloseTo(30 + 4.6 / 60, 4);
  });

  test("J-68-2026 — DMM symbol form with sequential numbering and typo (° for ')", () => {
    const sample = `- Indre fjord
Fiskeforbudsområdet ligger innenfor linje som avgrenses av følgende koordinater:

1  59° 24,938'N  010° 29,864°Ø 2  59° 25,127'N  010° 35,424°Ø

- Færder
Fiskeforbudsområdet er definert ved følgende koordinater:

1  59° 14,402'N  010° 28,211'Ø 2  59° 14,583'N  010° 29,010'Ø 3  59° 14,899'N  010° 28,995'Ø
`;
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    const allPoints = result.areas.flatMap((a) => a.points);
    expect(allPoints.length).toBe(5);
    expect(allPoints[0].lat).toBeCloseTo(59 + 24.938 / 60, 4);
    expect(allPoints[0].lon).toBeCloseTo(10 + 29.864 / 60, 4);
  });

  test("J-68-2026 — groups points under preceding bullet headings", () => {
    const sample = `- Indre fjord
Fiskeforbudsområdet:

1  59° 24,938'N  010° 29,864'Ø 2  59° 25,127'N  010° 35,424'Ø

- Færder
Fiskeforbudsområdet:

1  59° 14,402'N  010° 28,211'Ø 2  59° 14,583'N  010° 29,010'Ø
`;
    const result = parseJmeldingGeo(sample);
    const names = result.areas.map((a) => a.name);
    expect(names).toContain("Indre fjord");
    expect(names).toContain("Færder");
  });

  test("J-69-2026 — British zone has no coordinates, returns no geo", () => {
    const sample =
      "Det er forbudt for norske fartøy å fiske i britisk sone i ICES´ statistikkområder 4, 2.a, 5.b, 6.a. og 6.b. i 2026.";
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(false);
    expect(result.areas).toEqual([]);
    expect(result.bbox).toBeNull();
  });

  test("J-70-2026 — half-plane reference (nord for 62° N) is NOT a point", () => {
    const sample =
      "Det er forbudt for norske fartøy å fiske og lande kveite nord for 62°N i 2026.";
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(false);
  });

  test("J-173-2018 — DMS form in table rows", () => {
    const sample = `| Nornes | Aksnes |   |   |
| Grader, minutter og desimalsekunder 60° 12' 15,065" N 6° 34' 4,812" Ø | Grader og desimalminutter 60° 12,251' N 6° 34,080' Ø |`;
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    const points = result.areas.flatMap((a) => a.points);
    expect(points.length).toBe(1);
    expect(points[0].lat).toBeCloseTo(60 + 12 / 60 + 15.065 / 3600, 5);
    expect(points[0].lon).toBeCloseTo(6 + 34 / 60 + 4.812 / 3600, 5);
  });

  test("J-173-2018 — unicode curly quotes are normalized", () => {
    const sample = `60° 17' 20,655” N 6° 37' 43,334” Ø`;
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    expect(result.areas[0].points[0].lat).toBeCloseTo(
      60 + 17 / 60 + 20.655 / 3600,
      5,
    );
  });

  test("DMS regex does not also match DMM portion of same row", () => {
    const sample = `60° 12' 15,065" N 6° 34' 4,812" Ø`;
    const result = parseJmeldingGeo(sample);
    expect(result.areas.flatMap((a) => a.points).length).toBe(1);
  });

  test("rejects out-of-range coordinates", () => {
    const sample = "Nord 200 grader 0,0 minutter. Øst 999 grader 0,0 minutter.";
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(false);
  });

  test("bbox aggregates all areas correctly", () => {
    const sample = `
- Area One
1. Nord 60 grader 0,0 minutter. Øst 5 grader 0,0 minutter.
- Area Two
2. Nord 70 grader 0,0 minutter. Øst 15 grader 0,0 minutter.
`;
    const result = parseJmeldingGeo(sample);
    expect(result.bbox).toEqual([5, 60, 15, 70]);
  });

  test("J-30-2023 — Lofoten format with bullet-prefixed coordinates", () => {
    const sample = `Moholmen
- Nord 68 grader 06,00 minutter. Øst 14 grader 28,00 minutter.
- Nord 68 grader 05,50 minutter. Øst 14 grader 20,00 minutter.
- Nord 68 grader 07,00 minutter. Øst 14 grader 20,00 minutter.

Henningsvær
- Nord 68 grader 07,90 minutter. Øst 14 grader 09,96 minutter.
- Nord 68 grader 08,05 minutter. Øst 14 grader 13,22 minutter.`;
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    const points = result.areas.flatMap((a) => a.points);
    expect(points.length).toBe(5);
    expect(points[0].lat).toBeCloseTo(68 + 6 / 60, 4);
  });

  test("Southern hemisphere uses negative latitude", () => {
    const sample = "Sør 50 grader 0,0 minutter. Vest 10 grader 0,0 minutter.";
    const result = parseJmeldingGeo(sample);
    expect(result.hasGeo).toBe(true);
    expect(result.areas[0].points[0].lat).toBeCloseTo(-50, 4);
    expect(result.areas[0].points[0].lon).toBeCloseTo(-10, 4);
  });
});

describe("areasToFeatureCollection", () => {
  test("returns null for empty areas", () => {
    expect(areasToFeatureCollection([])).toBeNull();
  });

  test("builds MultiPoint feature per area", () => {
    const fc = areasToFeatureCollection([
      { name: "A", points: [{ lat: 60, lon: 5 }] },
      { name: null, points: [{ lat: 61, lon: 6 }] },
    ]);
    expect(fc).not.toBeNull();
    expect(fc?.type).toBe("FeatureCollection");
    expect(fc?.features.length).toBe(2);
    expect(fc?.features[0].geometry.type).toBe("MultiPoint");
    expect(fc?.features[0].geometry.coordinates).toEqual([[5, 60]]);
    expect(fc?.features[0].properties.name).toBe("A");
    expect(fc?.features[1].properties.name).toBeNull();
  });
});

describe("areasToWkt", () => {
  test("null for no points", () => {
    expect(areasToWkt([])).toBeNull();
    expect(areasToWkt([{ name: null, points: [] }])).toBeNull();
  });

  test("flattens all areas into a single MULTIPOINT", () => {
    const wkt = areasToWkt([
      { name: "A", points: [{ lat: 60, lon: 5 }] },
      { name: "B", points: [{ lat: 61, lon: 6 }] },
    ]);
    expect(wkt).toBe("MULTIPOINT(5.000000 60.000000,6.000000 61.000000)");
  });
});
