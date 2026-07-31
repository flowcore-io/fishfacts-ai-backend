import { describe, expect, test } from "bun:test";
import { type GeoPoint, parseJmeldingGeo } from "./geo-parser";

// Every fixture below is the real body markdown the fiskeridir job produces for
// the named notice (fetched 2026-07-31, run through the job's htmlToMarkdown),
// trimmed to the sections under test.

function longestEdgeKm(points: GeoPoint[]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  let longest = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    longest = Math.max(longest, 2 * 6371 * Math.asin(Math.sqrt(h)));
  }
  return longest;
}

// J-95-2026: eight fjord closures — two in the amendment (§ 7, § 8), then all
// eight again in the consolidated text, under no heading of their own. This is
// the notice from report d981acd8: grouping by heading put every position in
// one ring, which drew as edges from Finnmark to Trøndelag.
const J_95_2026 = `# J-95-2026: Forskrift om endring om stenging av områder nord for 62°N for fiske etter reker med trål

Fastsatt av Fiskeridirektoratet 15. juni 2026 med hjemmel i lov 6. juni 2008 nr. 37 om forvaltning av viltlevande marine ressursar § 16 og forskrift 23. desember 2021 nr. 3910 om gjennomføring av fiske, fangst og høsting av viltlevende marine ressurser § 50 bokstav a.

I

I forskrift 29. juni 2011 om stenging av områder nord for 62°N for fiske etter reker med trål gjøres følgende endring:

§§ 5 og 6 oppheves.

§ 7 (ny) skal lyde:

Det er forbudt å fiske i et område på Gåsværfjorden og Mesøyfjorden i Nordland avgrenset av rette linjer mellom følgende posisjoner.

1. Nord 66 grader 51,100 minutter. Øst 013 grader 23,500 minutter. 2. Nord 66 grader 51,900 minutter. Øst 013 grader 23,500 minutter. 3. Nord 66 grader 51,700 minutter. Øst 013 grader 36,000 minutter. 4. Nord 66 grader 50,600 minutter. Øst 013 grader 36,000 minutter. herfra i en rett linje tilbake til posisjon 1.

§ 8 (ny) skal lyde

Det er forbudt å fiske i et område på Mistfjorden i Nordland avgrenset av rette linjer mellom følgende posisjoner.

1. Nord 67 grader 26,900 minutter. Øst 014 grader 48,700 minutter. 2. Nord 67 grader 27,400 minutter. Øst 014 grader 48,700 minutter. 3. Nord 67 grader 26,700 minutter. Øst 014 grader 56,900 minutter. 4. Nord 67 grader 25,900 minutter. Øst 014 grader 56,300 minutter. herfra i en rett linje tilbake til posisjon 1.

II

Forskriften trer i kraft straks.

Forskriften lyder etter dette:

Det er forbudt å fiske etter reker med trål på Varanger i Troms og Finnmark i et område avgrenset av rette linjer mellom følgende posisjoner:

1. Nord 70 grader 03,5 minutter. Øst 029 grader 06,7 minutter. 2. Nord 70 grader 06,8 minutter. Øst 029 grader 11,7 minutter. 3. Nord 70 grader 04,0 minutter. Øst 029 grader 44,0 minutter. 4. Nord 69 grader 58,6 minutter. Øst 029 grader 41,5 minutter. Herfra videre til posisjon 1.

Det er forbudt å fiske etter reker med trål i et område på Tvibergfeltet i Trøndelag i et område beskrevet med følgende posisjoner:

1. Nord 64 grader 45,000 minutter. Øst 011 grader 04,900 minutter. 2. Nord 64 grader 46,300 minutter. Øst 011 grader 09,100 minutter. 3. Nord 64 grader 46,100 minutter. Øst 011 grader 10,000 minutter. 4. Nord 64 grader 44,800 minutter. Øst 011 grader 06,000 minutter. Herfra videre en rett linje til posisjon 1.

Det er forbudt å fiske etter reker med trål i et område på Rossøystraumen i Trøndelag i et område beskrevet med følgende posisjoner:

1. Nord 64 grader 47,200 minutter. Øst 011 grader 08,800 minutter. 2. Nord 64 grader 48,200 minutter. Øst 011 grader 11,300 minutter. 3. Nord 64 grader 48,200 minutter. Øst 011 grader 11,800 minutter. 4. Nord 64 grader 47,500 minutter. Øst 011 grader 11,400 minutter. 5. Nord 64 grader 47,100 minutter. Øst 011 grader 09,500 minutter. Herfra videre en rett linje til posisjon 1.

Det er det forbudt å fiske reker med trål, med maskevidde mindre enn 40 mm i et område ved Kjøtta i Troms i et område avgrenset av rette linjer mellom følgende posisjoner:

1. Nord 68 grader 51,000 minutter. Øst 016 grader 48,000 minutter. 2. Nord 68 grader 54,500 minutter. Øst 016 grader 46,000 minutter. 3. Nord 68 grader 54,500 minutter. Øst 016 grader 48,000 minutter. 4. Nord 68 grader 51,500 minutter. Øst 016 grader 52,500 minutter. Herfra i en rett linje tilbake til posisjon 1.

Det er forbudt å fiske i etter reker i Kilværfjorden i Nordland i et område avgrenset av rette linjer mellom følgende posisjoner.

1. Nord 65 grader 47.500 minutter. Øst 011 grader 50.300 minutter. 2. Nord 65 grader 48.800 minutter. Øst 011 grader 55.300 minutter. 3. Nord 65 grader 48.300 minutter. Øst 011 grader 56.700 minutter. 4. Nord 65 grader 46.900 minutter. Øst 011 grader 52.000 minutter. herfra i en rett linje tilbake til posisjon 1.

Det er forbudt å fiske etter reker med trål i et område på Sørfjorden i Nordland avgrenset av rette linjer mellom følgende posisjoner.

1. Nord 65 grader 55.300 minutter. Øst 012 grader 38.600 minutter. 2. Nord 65 grader 57.500 minutter. Øst 012 grader 43.400 minutter. 3. Nord 65 grader 58.800 minutter. Øst 012 grader 48.600 minutter. 4. Nord 65 grader 58.400 minutter. Øst 012 grader 49.400 minutter. 5. Nord 65 grader 55.000 minutter. Øst 012 grader 39.400 minutter. herfra i en rett linje tilbake til posisjon 1.

Det er forbudt å fiske i et område på Gåsværfjorden og Mesøyfjorden i Nordland avgrenset av rette linjer mellom følgende posisjoner.

1. Nord 66 grader 51,100 minutter. Øst 013 grader 23,500 minutter. 2. Nord 66 grader 51,900 minutter. Øst 013 grader 23,500 minutter. 3. Nord 66 grader 51,700 minutter. Øst 013 grader 36,000 minutter. 4. Nord 66 grader 50,600 minutter. Øst 013 grader 36,000 minutter. herfra i en rett linje tilbake til posisjon 1.

Det er forbudt å fiske i et område på Mistfjorden i Nordland avgrenset av rette linjer mellom følgende posisjoner.

1. Nord 67 grader 26,900 minutter. Øst 014 grader 48,700 minutter. 2. Nord 67 grader 27,400 minutter. Øst 014 grader 48,700 minutter. 3. Nord 67 grader 26,700 minutter. Øst 014 grader 56,900 minutter. 4. Nord 67 grader 25,900 minutter. Øst 014 grader 56,300 minutter.

Forskriften trer i kraft straks.`;

describe("J-95-2026 — one area per closure", () => {
  const parsed = parseJmeldingGeo(J_95_2026);

  test("splits the eight closures the notice defines", () => {
    expect(parsed.areas.map((a) => [a.name, a.points.length])).toEqual([
      ["Gåsværfjorden og Mesøyfjorden i Nordland", 4],
      ["Mistfjorden i Nordland", 4],
      ["Varanger i Troms og Finnmark", 4],
      ["Tvibergfeltet i Trøndelag", 4],
      ["Rossøystraumen i Trøndelag", 5],
      ["Kjøtta i Troms", 4],
      ["Kilværfjorden i Nordland", 4],
      ["Sørfjorden i Nordland", 5],
    ]);
  });

  test("no area spans fjords hundreds of km apart", () => {
    for (const area of parsed.areas) {
      expect(longestEdgeKm(area.points)).toBeLessThan(30);
    }
  });

  test("keeps every distinct position (the consolidated repeat is deduped)", () => {
    const total = parsed.areas.reduce((n, a) => n + a.points.length, 0);
    expect(total).toBe(34);
    expect(parsed.hasGeo).toBe(true);
  });
});

// J-112-2025 lists its corners as bullets with no position numbers at all —
// only the lead-in sentence and the "Herfra videre til posisjon 1" terminator
// mark where one closure ends.
const J_112_2025_BULLETS = `Det er forbudt å fiske etter reker med trål på Varanger i Troms og Finnmark i et område avgrenset av rette linjer mellom følgende posisjoner:

- Nord 70 grader 03,5 minutter. Øst 029 grader 06,7 minutter.
- Nord 70 grader 06,8 minutter. Øst 029 grader 11,7 minutter.
- Nord 70 grader 04,0 minutter. Øst 029 grader 44,0 minutter.
- Nord 69 grader 58,6 minutter. Øst 029 grader 41,5 minutter. Herfra videre til posisjon 1.
Det er forbudt å fiske etter reker med trål i et område på Vengsøyfjorden i Troms og Finnmark i et område avgrenset av rette linjer mellom følgende posisjoner:

- Nord 69 grader 47,800 minutter. Øst 018 grader 23,000 minutter.
- Nord 69 grader 49,000 minutter. Øst 018 grader 23,000 minutter.
- Nord 69 grader 49,500 minutter. Øst 018 grader 39,500 minutter.
- Nord 69 grader 48,500 minutter. Øst 018 grader 39,500 minutter. Herfra videre til posisjon 1.`;

test("splits unnumbered bullet lists on the lead-in and ring terminator", () => {
  const parsed = parseJmeldingGeo(J_112_2025_BULLETS);
  expect(parsed.areas.map((a) => [a.name, a.points.length])).toEqual([
    ["Varanger i Troms og Finnmark", 4],
    ["Vengsøyfjorden i Troms og Finnmark", 4],
  ]);
});

// J-125-2026 § 12 numbers its last two corners "5." and "5." — a typo in the
// source, inside one ring. A repeat is not a restart.
const J_125_2026_SECTION_12 = `### § 12 Lopphavet i Troms og Finnmark

Det er forbudt å fiske etter sei med not i et område på Lopphavet i Troms og Finnmark, avgrenset av rette linjer mellom følgende posisjoner:

1. Nord 70 grader 19.500 minutter  Øst 020 grader 40.900 minutter 2. Nord 70 grader 22.900 minutter  Øst 020 grader 35.400 minutter 3. Nord 70 grader 27.700 minutter  Øst 020 grader 39.800 minutter 4. Nord 70 grader 27.900 minutter  Øst 021 grader 08.400 minutter 5. Nord 70 grader 27.400 minutter  Øst 021 grader 10.900 minutter 5. Nord 70 grader 19.400 minutter  Øst 020 grader 49.600 minutter Herfra videre til posisjon 1.`;

test("a repeated position number does not split the ring", () => {
  const parsed = parseJmeldingGeo(J_125_2026_SECTION_12);
  expect(parsed.areas).toHaveLength(1);
  expect(parsed.areas[0].points).toHaveLength(6);
  expect(parsed.areas[0].name).toBe("§ 12 Lopphavet i Troms og Finnmark");
});

// J-238-2025 § 19 describes two separate closing lines in one section — one
// across Vestfjorden, one in Hellemofjorden 40 km away.
const J_238_2025_SECTION_19 = `### § 19 Stengte områder i Nordland

Det er forbudt å fiske med trål, samt forbudt for fartøy på eller over 21,35 meter største lengde som fisker med not å fiske i Vestfjorden og innenfor liggende fjordsystemer, innenfor en linje trukket mellom punktene 68°18'N 15°39'Ø og 68°11'N 15°36'Ø (Offersøya - Tranøy). I nord er området avgrenset av en rett linje lands 68°40'N tvers av Tjeldsundet.

Det er forbudt å fiske med not (unntatt landnot) i Hellemofjorden sør for en linje trukket mellom punktene 68°01,12'N 16°11,62'Ø til 68°00,95'N 16°10,20'Ø (Hestneset sør til Hellandsberg).`;

test("two closing lines under one § stay two areas", () => {
  const parsed = parseJmeldingGeo(J_238_2025_SECTION_19);
  expect(parsed.areas.map((a) => a.points.length)).toEqual([2, 2]);
});

// J-117-2026 arrives as one long unbroken line, so its later closures sit far
// past the window a heading may be read from. Running out of heading is not the
// end of a ring — this used to cut Varanger in half after its second corner.
const J_117_2026_SINGLE_LINE = `## Kart

- Sjøkart ${"Fastsatt av Fiskeridirektoratet 30. juni 2026. ".repeat(40)} § 1 Det er forbudt å fiske etter reker med trål på Varanger i Troms og Finnmark i et område avgrenset av rette linjer mellom følgende posisjoner: 1. Nord 70 grader 03,5 minutter. Øst 029 grader 06,7 minutter. 2. Nord 70 grader 06,8 minutter. Øst 029 grader 11,7 minutter. 3. Nord 70 grader 04,0 minutter. Øst 029 grader 44,0 minutter. 4. Nord 69 grader 58,6 minutter. Øst 029 grader 41,5 minutter. Herfra videre til posisjon 1. § 2 Det er forbudt å fiske etter reker med trål i et område på Tvibergfeltet i Trøndelag beskrevet med følgende posisjoner: 1. Nord 64 grader 45,000 minutter. Øst 011 grader 04,900 minutter. 2. Nord 64 grader 46,300 minutter. Øst 011 grader 09,100 minutter. 3. Nord 64 grader 46,100 minutter. Øst 011 grader 10,000 minutter. 4. Nord 64 grader 44,800 minutter. Øst 011 grader 06,000 minutter. Herfra videre en rett linje til posisjon 1.`;

test("a ring running past the heading window is not cut in half", () => {
  const parsed = parseJmeldingGeo(J_117_2026_SINGLE_LINE);
  expect(parsed.areas.map((a) => a.points.length)).toEqual([4, 4]);
});
