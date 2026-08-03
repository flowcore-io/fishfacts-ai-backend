import { describe, expect, test } from "bun:test";
import { drawableAreas, extractAreas, isVertexItem } from "./areas";

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
