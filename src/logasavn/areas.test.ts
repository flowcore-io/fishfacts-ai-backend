import { describe, expect, test } from "bun:test";
import {
  countCoordinateLike,
  countDecimalDegreeRows,
  drawableAreas,
  extractAreas,
  isVertexItem,
} from "./areas";

// Every fixture below is copied verbatim out of the Lógasavn fragment for the
// statute named, so each one pins a real shape the corpus actually contains.

// Kunngerð 35/2026 § 2 — the Føroyabanki definition, and the reason the
// notation matters: it is entirely degrees-minutes-SECONDS. A decimal-minutes
// regex finds ZERO vertices here, so the plan of record would have shipped no
// polygon for the single area users ask for by name.
//
// Note vertex 10 — the ring-closing repeat — has the next section's heading
// ("Fiskidagatal") glued onto its line. That is not a typo in this fixture; it
// is how the markdown is written, and dropping that vertex opens the ring.
const FOROYABANKI = `### § 2.

 Í hesi kunngerð er Føroyabanki leiðirnar innan fyri beinar linjur drignar gjøgnum hesi støð í hesi raðfylgju:
- **1)**60°57'20"N - 07°57'00"V
- **2)**61°03'00"N - 07°57'00"V
- **3)**61°15'30"N - 08°16'00"V
- **4)**61°13'20"N - 08°42'12"V
- **5)**61°00'00"N - 09°11'00"V
- **6)**60°48'40"N - 09°25'00"V
- **7)**60°26'00"N - 09°08'25"V
- **8)**60°36'30"N - 08°45'00"V
- **9)**60°45'40"N - 08°37'00"V
- **10)**60°57'20"N - 07°57'00"V Fiskidagatal `;

// Kunngerð 30/2018 Stk. 10–12. Three shapes in one fixture:
//   Øki G — a plain numbered vertex list (11 points)
//   Øki H — a boundary stated as a bearing and a parallel, no vertex list
//   Øki I — a bearing origin in PROSE followed by a real 3-vertex list
// Øki I is the case that motivates prefix-anchored vertex detection: Barðinum's
// coordinate is fully paired, so pair-completeness cannot reject it, and it
// silently became the area's first vertex.
const OKI_G_H_I = `**Stk. 10.** Í øki G alt árið 12 fjórðingar úr grundlinjunum og innan fyri linjur drignar millum hesi støð:
- **1)**61°37,000'N 07°33,000'V
- **2)**61°30,000'N 07°45,000'V
- **3)**61°26,000'N 07°45,000'V
- **4)**61°26,800'N 07°49,200'V
- **5)**61°27,300'N 08°04,000'V
- **6)**61°29,000'N 08°10,000'V
- **7)**61°30,500'N 08°13,000'V
- **8)**61°34,500'N 08°15,000'V
- **9)**61°36,000'N 08°10,000'V
- **10)**61°31,500'N 07°56,000'V
- **11)**61°41,000'N 07°38,500'V

**Stk. 11.** Í øki H alt árið millum 12 og 19 fjórðingar úr grundlinjunum millum breiddarstigið 61°57,000'N og 315° rættvísandi úr Barðinum 62°08,800'N 07°26,000'V.

**Stk. 12.** Í øki I, fyri fiskifør við 500 HK maskinorku ella meiri, millum 12 og 19 fjórðingar úr grundlinjunum millum 315° rættvísandi úr Barðinum 62°08,800'N 07°26,000'V og innan fyri linjur drignar millum hesi støð:
- **1)**62°30,000'N 07°45,000'V
- **2)**62°30,000'N 07°30,000'V
- **3)**62°26,083'N 07°30,000'V `;

// Kunngerð 30/2018 § 5 — Øki A is the Føroya Banki closure, øki a is the zone
// INSIDE it where fishing is permitted between 1 September and 31 May. Case is
// the only thing distinguishing them.
const OKI_A_AND_LOWER_A = `**Stk. 1.** Í øki A alt árið innan fyri linjur drignar millum hesi støð:
- **1)**60°50,000'N 007°57,000'V
- **2)**61°03,000'N 007°57,000'V
- **3)**61°15,500'N 008°16,000'V
- **4)**60°50,000'N 007°57,000'V

**Stk. 2.** Hóast ásetingina í stk. 1 er, í øki a, loyvt at veiða í tíðarskeiðinum frá 1. september til 31. mai innan fyri linjur drignar millum hesi støð:
- **1)**60°50,000'N 007°57,000'V
- **2)**60°57,333'N 007°57,000'V
- **3)**60°45,667'N 008°37,000'V
- **4)**60°50,000'N 007°57,000'V `;

// Kunngerð 45/2022 § 2 — the spawning closures. Here the NUMBERED items are
// rules and the LETTERED sub-items are the vertices, the exact inverse of
// K 30/2018. Rule 2 is a pure descriptor (two bearing origins, no vertex list)
// and must contribute no polygon.
const GYTINGARLEIDIR = `### § 2.


- **1)**Í tíðarskeiðinum frá 1. februar til 1. mai er ikki loyvt at veiða við nøkrum veiðihátti innan fyri linjur drignar millum hesi støð og í hesi raðfylgju:
  - **a)**61°40,000 N - 008°25,000 V
  - **b)**61°54,000 N - 008°40,000 V
  - **c)**61°54,000 N - 007°25,500 V
  - **d)**61°58,000 N - 007°15,000 V
  - **e)**61°40,000 N - 008°25,000 V
- **2)**Í tíðarskeiðinum frá 1. februar til 1. mai er fiskiførum størri enn 80 tons ikki loyvt at veiða við línu millum 315° rættvísandi úr Barðinum, 62°08,800 N - 007°26,000 V, og 360° rættvísandi úr Mýlingi, 62°18,180 N - 007°12,500 V, og millum 6 fjórðingar og 12 fjórðingar úr grundlinjunum. `;

// Kunngerð 193/2017 § 9a — the acute-accent notation (`62°00´000 N`), which is
// neither the comma-decimal nor the seconds form.
const ACUTE_ACCENT = `**Stk. 2.** Í tíðarskeiðinum 1. apríl til 1. november er fiskiskapur við línu ikki loyvdur innan fyri linjur drignar millum hesi støð:
- **1)**62°00´000 N 07°40´000 V
- **2)**62°05´000 N 07°40´000 V
- **3)**62°05´000 N 07°50´000 V
- **4)**62°00´000 N 07°40´000 V `;

describe("coordinate notations", () => {
  test("parses degrees-minutes-seconds (Føroyabanki, K 35/2026)", () => {
    const areas = drawableAreas(FOROYABANKI);
    expect(areas).toHaveLength(1);

    // 60°57'20"N = 60 + 57/60 + 20/3600
    expect(areas[0].points[0].lat).toBeCloseTo(60.955556, 5);
    expect(areas[0].points[0].lng).toBeCloseTo(-7.95, 5);
    // 61°13'20"N 08°42'12"V — the seconds must survive; truncating to `61°13'`
    // would move this vertex by nearly a nautical mile.
    expect(areas[0].points[3].lat).toBeCloseTo(61.222222, 5);
    expect(areas[0].points[3].lng).toBeCloseTo(-8.703333, 5);
  });

  test("keeps the ring-closing vertex when a heading is glued to its line", () => {
    const [area] = drawableAreas(FOROYABANKI);
    expect(area.points).toHaveLength(10);
    expect(area.ringClosed).toBe(true);
  });

  test("parses the acute-accent notation (K 193/2017 § 9a)", () => {
    const [area] = drawableAreas(ACUTE_ACCENT);
    expect(area.points).toHaveLength(4);
    expect(area.points[0].lat).toBeCloseTo(62.0, 5);
    expect(area.points[0].lng).toBeCloseTo(-7.666667, 5);
  });

  test("west and south are negative", () => {
    const [area] = drawableAreas(ACUTE_ACCENT);
    expect(area.points.every((p) => p.lng < 0)).toBe(true);
    expect(area.points.every((p) => p.lat > 0)).toBe(true);
  });
});

describe("vertex vs descriptor", () => {
  test("a coordinate in prose never becomes a vertex", () => {
    const areas = extractAreas(OKI_G_H_I);
    const okiI = areas.find((a) => a.name === "I");

    // Barðinum (62°08,800'N 07°26,000'V) is a bearing origin in Stk. 12's
    // prose. It is fully paired, so only its position in the sentence rejects
    // it — and it must not appear among the vertices.
    expect(okiI?.points).toHaveLength(3);
    expect(okiI?.points[0].lat).toBeCloseTo(62.5, 5);
    expect(okiI?.descriptorCount).toBeGreaterThan(0);
  });

  test("a boundary stated only as bearings yields no area at all", () => {
    // Øki H is "between the 61°57,000'N parallel and 315° true from Barðinum".
    // That is a job for the descriptor resolver, not a polygon.
    expect(extractAreas(OKI_G_H_I).some((a) => a.name === "H")).toBe(false);
  });

  test("isVertexItem separates the two forms directly", () => {
    expect(isVertexItem("61°40,000 N - 008°25,000 V ")).toBe(true);
    expect(isVertexItem("60°57'20\"N - 07°57'00\"V Fiskidagatal ")).toBe(true);
    expect(
      isVertexItem(
        "Í tíðarskeiðinum er ikki loyvt at veiða millum 315° rættvísandi úr Barðinum, 62°08,800 N - 007°26,000 V, og 360°…",
      ),
    ).toBe(false);
  });
});

describe("segmentation", () => {
  test("numbered vertices (K 30/2018) stay in one area", () => {
    const okiG = extractAreas(OKI_G_H_I).find((a) => a.name === "G");
    expect(okiG?.points).toHaveLength(11);
  });

  test("lettered vertices under numbered rules (K 45/2022) split per rule", () => {
    const areas = drawableAreas(GYTINGARLEIDIR);
    // Rule 1 is a real 5-vertex ring; rule 2 is pure descriptor and drops out.
    expect(areas).toHaveLength(1);
    expect(areas[0].points).toHaveLength(5);
    expect(areas[0].ringClosed).toBe(true);
  });

  test("area case is preserved — a closure and its exemption stay distinct", () => {
    const areas = extractAreas(OKI_A_AND_LOWER_A);
    expect(areas.map((a) => a.name)).toEqual(["A", "a"]);
    // Different geometry: øki a is the permitted zone inside Øki A.
    expect(areas[0].points[1].lat).not.toBeCloseTo(areas[1].points[1].lat, 5);
  });
});

// A survey of all 7,405 Lógasavn fragments (Usable Knowledge 714320cb) found
// 135 distinct coordinate shapes, not the four this parser was first built for.
// Each row below is a real family from that census, and each is asserted on the
// VALUE rather than the vertex count — the failure these guard against moves a
// vertex rather than losing one, so counting corners cannot see it. Writing
// this table is how the dropped `.63` in `22.63″` was found: a 19 m error that
// every count-based test passed.
const NOTATIONS: [string, string, number][] = [
  [
    "decimal before the seconds mark (Anordning 598/1976)",
    "65° 41′ 22.63″ N 5° 34′ 42.22″ W",
    65 + 41 / 60 + 22.63 / 3600,
  ],
  [
    "decimal after the seconds mark (Løgtingslóg 80/2003)",
    "61° 20’ 10’’.85 N 006° 40’ 23’’.77 V",
    61 + 20 / 60 + 10.85 / 3600,
  ],
  [
    "seconds closed by two apostrophes (K 4/2026)",
    "60°20'00''N 06°00'00''V",
    60 + 20 / 60,
  ],
  [
    "typographic doubled quote (K 197/2021, NAFO)",
    "48° 17’39’’N 47° 25’37’’V",
    48 + 17 / 60 + 39 / 3600,
  ],
  [
    "acute accent with a four-digit fraction (K 236/2025)",
    "62°24´7090 N 006°33´3655 V",
    62 + 24.709 / 60,
  ],
  [
    "`º` U+00BA masculine ordinal, not `°` U+00B0",
    "61º49'00\"N 06º30'00\"V",
    61 + 49 / 60,
  ],
  ["degrees and minutes only (K 28/2014)", "59° 45' N 33° 30' V", 59 + 45 / 60],
  ["bare degrees — a box corner (K 11/2026)", "62°N 06°V", 62],
];

describe("notation coverage (corpus census 714320cb)", () => {
  for (const [label, vertex, expectedLat] of NOTATIONS) {
    test(label, () => {
      const md = `**Stk. 1.** Innan fyri linjur drignar millum hesi støð:\n- **1)**${vertex}\n- **2)**${vertex}\n- **3)**${vertex} `;
      const [area] = drawableAreas(md);
      expect(area).toBeDefined();
      expect(area.points[0].lat).toBeCloseTo(expectedLat, 9);
      expect(area.points[0].lng).toBeLessThan(0); // all are western
    });
  }
});

// Kunngerð 102/2024 § 2, Skjal 1 — the NEAFC annex, in plain signed decimal
// degrees. Read the heading: *"Knattstøður fyri verandi fiskileiðir"*,
// coordinates for EXISTING FISHING GROUNDS. K 113/2014 § 6 says bottom fishing
// OUTSIDE these needs an exploratory licence, so they map where fishing is
// permitted — the exact inverse of a closure.
const NEAFC_TABLE = `### § 2

 Henda kunngerð kemur í gildi dagin eftir, at hon er kunngjørd. Skjal 1 “Skjal 1 Knattstøður fyri verandi fiskileiðir í NEAFC-skipanarøkinum Talva 1 BAR 1 Breiddarstig Longdarstig 1 74.1356 41.0604 2 73.7439 41.36 3 73.4273 41.0317 4 73.1143 40.7075 5 74.1356 41.0604 Talva 2 HAR 1 Breiddarstig Longdarstig 1 60.0557 -14.2048 2 59.6708 -14.0275 3 59.5262 -14.2562 4 59.3197 -14.6393 5 60.0557 -14.2048 Talva 13 Reykjanes Ridge Breiddarstig Longdarstig 1 60.9844 -27.0000 2 60.8811 -27.4432 3 60.8893 -27.6897 4 60.9592 -27.8432 5 60.9844 -27.0000 „`;

describe("decimal-degree tables are not areas", () => {
  test("reads no ring out of the fishing-grounds annex", () => {
    // Every one of these 13 tables parsed perfectly when we had a reader for
    // them, which is why this has to be asserted rather than assumed: the shape
    // is valid geometry and the ONLY thing marking it as fishing grounds rather
    // than closures is the Faroese prose above it.
    expect(drawableAreas(NEAFC_TABLE)).toHaveLength(0);
  });

  test("still sees the coordinates, so the fragment stays a candidate", () => {
    // Detection and extraction must NOT agree here. The statute genuinely holds
    // coordinates and belongs in the index for a reader who can understand it;
    // what we refuse is to decide on our own what they mean. Note the degree-sign
    // detector is blind to this notation — losing the table reader without this
    // second counter would have dropped K 102/2024 out of the corpus entirely.
    expect(countCoordinateLike(NEAFC_TABLE)).toBe(0);
    expect(countDecimalDegreeRows(NEAFC_TABLE)).toBeGreaterThan(0);
  });
});

describe("failing closed", () => {
  // A vertex line in a notation the tokenizer cannot read used to vanish from
  // the ring silently — the polygon simply had fewer corners than the statute
  // said. Across the corpus that hit ten in-force statutes. The area must now
  // be withheld and counted instead.
  const WITH_UNREADABLE_VERTEX = `**Stk. 1.** Innan fyri linjur drignar millum hesi støð:
- **1)**61°40,000'N 007°33,000'V
- **2)**61°30,000'N 007°45,000'V
- **3)**61°26,000‚000'N 007°45,000‚000'V
- **4)**61°40,000'N 007°33,000'V `;

  test("an unreadable vertex withholds the whole area", () => {
    expect(drawableAreas(WITH_UNREADABLE_VERTEX)).toHaveLength(0);
  });

  test("...and says so rather than failing silently", () => {
    const [area] = extractAreas(WITH_UNREADABLE_VERTEX);
    expect(area.unparsed).toBeGreaterThan(0);
    // The readable vertices are still parsed — the area is held, not discarded,
    // so an operator can see how much was understood.
    expect(area.points.length).toBeGreaterThan(0);
  });

  test("a heading glued to a vertex is undecidable, so nothing is drawn", () => {
    // The fixtures glue a bare title word (`Fiskidagatal`), which HEADING_RE
    // ignores; 0 of the corpus's 5,508 vertex lines glue a `**Stk. N.**` marker
    // instead. The corpus is re-scraped in place though, so this pins the
    // behaviour rather than today's data. Every available reading is wrong —
    // split before and the closing vertex tears both rings, never split and two
    // areas merge, split after and the glued text mislabels the wrong area — so
    // the ring is withheld instead of guessed at.
    const GLUED_HEADING = `**Stk. 1.** Innan fyri linjur drignar millum hesi støð:
- **1)**61°40,000'N 007°33,000'V
- **2)**61°30,000'N 007°45,000'V
- **3)**61°26,000'N 007°45,000'V
- **4)**61°40,000'N 007°33,000'V **Stk. 2.** Í øki B:
- **1)**62°40,000'N 007°33,000'V
- **2)**62°30,000'N 007°45,000'V
- **3)**62°26,000'N 007°45,000'V
- **4)**62°40,000'N 007°33,000'V `;
    expect(drawableAreas(GLUED_HEADING)).toHaveLength(0);
    expect(extractAreas(GLUED_HEADING)[0].unparsed).toBeGreaterThan(0);
  });

  test("a fully readable area is not held", () => {
    const [area] = extractAreas(FOROYABANKI);
    expect(area.unparsed).toBe(0);
    expect(drawableAreas(FOROYABANKI)).toHaveLength(1);
  });
});
