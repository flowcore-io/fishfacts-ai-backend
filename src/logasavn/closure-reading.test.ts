import { describe, expect, test } from "bun:test";
import { extractAreas } from "./areas";
import {
  type RingReading,
  type StatuteReading,
  compareReading,
  ringLabel,
} from "./closure-reading";

// The fixtures are the same verbatim corpus text `areas.test.ts` uses, so a
// change to the parser that breaks one file breaks both, rather than one of
// them quietly re-defining what the statute says.

// Kunngerð 35/2026 § 2 — Føroyabanki. Degrees-minutes-seconds throughout, and
// vertex 10 carries the next section's heading glued to its line.
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

/** The ten vertices of the fixture above, quoted the way the model is asked to. */
const FOROYABANKI_QUOTES = [
  { lat: `60°57'20"N`, lon: `07°57'00"V` },
  { lat: `61°03'00"N`, lon: `07°57'00"V` },
  { lat: `61°15'30"N`, lon: `08°16'00"V` },
  { lat: `61°13'20"N`, lon: `08°42'12"V` },
  { lat: `61°00'00"N`, lon: `09°11'00"V` },
  { lat: `60°48'40"N`, lon: `09°25'00"V` },
  { lat: `60°26'00"N`, lon: `09°08'25"V` },
  { lat: `60°36'30"N`, lon: `08°45'00"V` },
  { lat: `60°45'40"N`, lon: `08°37'00"V` },
  { lat: `60°57'20"N`, lon: `07°57'00"V` },
];

// Kunngerð 30/2018 § 5 — Øki A closed all year, øki a reopened inside it from
// 1 September to 31 May. Case is the only thing telling them apart.
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

const OKI_A_QUOTES = [
  { lat: `60°50,000'N`, lon: `007°57,000'V` },
  { lat: `61°03,000'N`, lon: `007°57,000'V` },
  { lat: `61°15,500'N`, lon: `008°16,000'V` },
  { lat: `60°50,000'N`, lon: `007°57,000'V` },
];

const LOWER_A_QUOTES = [
  { lat: `60°50,000'N`, lon: `007°57,000'V` },
  { lat: `60°57,333'N`, lon: `007°57,000'V` },
  { lat: `60°45,667'N`, lon: `008°37,000'V` },
  { lat: `60°50,000'N`, lon: `007°57,000'V` },
];

function ring(overrides: Partial<RingReading> = {}): RingReading {
  return {
    section: "§ 2",
    name: "Føroyabanki",
    kind: "closure",
    season: null,
    vertices: FOROYABANKI_QUOTES,
    ...overrides,
  };
}

function reading(rings: RingReading[]): StatuteReading {
  return { inForce: true, summary: "A closure.", rings };
}

describe("two readings that agree", () => {
  test("a ring quoted verbatim is drawn, at the coordinates the statute states", () => {
    const result = compareReading(reading([ring()]), extractAreas(FOROYABANKI));

    expect(result.withheld).toEqual([]);
    expect(result.unclaimed).toEqual([]);
    expect(result.agreed).toHaveLength(1);

    // Assert the VALUE, not the count. 60°57'20"N = 60 + 57/60 + 20/3600, and
    // a ring with the right number of corners in the wrong places passes every
    // check that counts them.
    const points = result.agreed[0]?.points ?? [];
    expect(points[0]?.lat).toBeCloseTo(60.9555555556, 9);
    expect(points[0]?.lng).toBeCloseTo(-7.95, 9);
    // Vertex 4 is where truncating the seconds would show: 61°13'20" vs 61°13'.
    expect(points[3]?.lat).toBeCloseTo(61.2222222222, 9);
    expect(points[3]?.lng).toBeCloseTo(-8.7033333333, 9);
  });

  test("a closing duplicate on one side only is not a disagreement", () => {
    // Whether a reader repeats the opening vertex to close the ring is a
    // formatting choice. Every count difference in the one measured comparison
    // against real statute text was exactly this.
    const open = ring({ vertices: FOROYABANKI_QUOTES.slice(0, -1) });

    const result = compareReading(reading([open]), extractAreas(FOROYABANKI));

    expect(result.withheld).toEqual([]);
    expect(result.agreed).toHaveLength(1);
  });

  test("whitespace around the marks is not a disagreement either", () => {
    const spaced = ring({
      vertices: FOROYABANKI_QUOTES.map((v) => ({
        lat: v.lat.replace(/°/, "° ").replace(/"/, `" `),
        lon: v.lon,
      })),
    });

    const result = compareReading(reading([spaced]), extractAreas(FOROYABANKI));

    expect(result.agreed).toHaveLength(1);
  });
});

describe("two readings that disagree — the point of the gate", () => {
  test("a dropped fractional second is caught", () => {
    // The failure class this whole arrangement exists for. Truncating the
    // seconds on vertex 7 moves it ~460 m; the ring still closes, still has ten
    // corners, and still draws. Nothing downstream can see it.
    const truncated = [...FOROYABANKI_QUOTES];
    truncated[6] = { lat: `60°26'00"N`, lon: `09°08'00"V` };

    const result = compareReading(
      reading([ring({ vertices: truncated })]),
      extractAreas(FOROYABANKI),
    );

    expect(result.agreed).toEqual([]);
    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]?.reason).toBe("no-parser-counterpart");
    // The ring the parser DID read is reported as unaccounted for, so a run
    // that silently loses a closure cannot look like a run that had none.
    expect(result.unclaimed).toHaveLength(1);
  });

  test("a re-ordered ring is refused, not accepted as the same shape", () => {
    // Same vertices, same water. Accepting a rotation would also accept a model
    // that re-shuffled the statute's list, which is a documented recovery
    // behaviour under retry pressure — and a re-ordered ring can cut across
    // land while passing every shape check.
    const rotated = ring({
      vertices: [
        ...FOROYABANKI_QUOTES.slice(2, -1),
        ...FOROYABANKI_QUOTES.slice(0, 2),
      ],
    });

    const result = compareReading(
      reading([rotated]),
      extractAreas(FOROYABANKI),
    );

    expect(result.agreed).toEqual([]);
    expect(result.withheld[0]?.reason).toBe("no-parser-counterpart");
  });

  test("a quote in a notation nothing can read withholds the whole ring", () => {
    const garbled = [...FOROYABANKI_QUOTES];
    garbled[2] = { lat: "sixty-one degrees", lon: `08°16'00"V` };

    const result = compareReading(
      reading([ring({ vertices: garbled })]),
      extractAreas(FOROYABANKI),
    );

    expect(result.agreed).toEqual([]);
    expect(result.withheld[0]?.reason).toBe("unreadable-quote");
    expect(result.withheld[0]?.detail).toContain("sixty-one degrees");
  });

  test("a ring the parser would not vouch for is an abstention, not agreement", () => {
    // K 45/2022's rule 2 states a boundary by bearing rather than by vertex
    // list, so the parser reads it as descriptive and withholds it. If the
    // model reads a shape there, nothing has corroborated it.
    const descriptive = `**Stk. 11.** Í øki H alt árið millum 12 og 19 fjórðingar úr grundlinjunum millum breiddarstigið 61°57,000'N og 315° rættvísandi úr Barðinum 62°08,800'N 07°26,000'V.`;

    const result = compareReading(
      reading([
        ring({
          name: "H",
          vertices: [
            { lat: `61°57,000'N`, lon: `007°26,000'V` },
            { lat: `62°08,800'N`, lon: `007°26,000'V` },
            { lat: `61°57,000'N`, lon: `008°00,000'V` },
          ],
        }),
      ]),
      extractAreas(descriptive),
    );

    expect(result.agreed).toEqual([]);
    expect(result.withheld[0]?.reason).toBe("no-parser-counterpart");
  });
});

describe("comprehension the parser cannot do", () => {
  test("the exemption inside a closure is matched but never drawn", () => {
    // The trap that re-inverts the law: `Øki A` is shut all year and `øki a` is
    // the water inside it that the same section reopens. Both rings parse, both
    // are valid, and only the prose says which is which.
    const result = compareReading(
      reading([
        ring({ section: "§ 5, stk. 1", name: "Øki A", vertices: OKI_A_QUOTES }),
        ring({
          section: "§ 5, stk. 2",
          name: "øki a",
          kind: "exemption",
          season: "1. september – 31. mai",
          vertices: LOWER_A_QUOTES,
        }),
      ]),
      extractAreas(OKI_A_AND_LOWER_A),
    );

    expect(result.agreed).toHaveLength(1);
    expect(result.agreed[0]?.reading.name).toBe("Øki A");
    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]?.reason).toBe("not-a-closure");
    // Matched, so it does not also show up as geometry nobody accounted for.
    expect(result.unclaimed).toEqual([]);
  });

  test("case is not normalised anywhere along the way", () => {
    // Upper-casing `øki a` merges it with `Øki A` and draws the closure over the
    // water it explicitly excludes.
    const result = compareReading(
      reading([
        ring({ section: "§ 5, stk. 1", name: "Øki A", vertices: OKI_A_QUOTES }),
        ring({
          section: "§ 5, stk. 2",
          name: "øki a",
          kind: "exemption",
          vertices: LOWER_A_QUOTES,
        }),
      ]),
      extractAreas(OKI_A_AND_LOWER_A),
    );

    expect(result.agreed[0]?.reading.name).toBe("Øki A");
    expect(result.withheld[0]?.reading.name).toBe("øki a");
  });

  test("a closure the model never mentioned is reported as unclaimed", () => {
    // The enumeration failure ingest exists to remove: the model reads one of
    // the two sections and declares the statute done. Withheld rings are loud;
    // unread ones would be silent without this.
    const result = compareReading(
      reading([
        ring({ section: "§ 5, stk. 1", name: "Øki A", vertices: OKI_A_QUOTES }),
      ]),
      extractAreas(OKI_A_AND_LOWER_A),
    );

    expect(result.agreed).toHaveLength(1);
    expect(result.unclaimed).toHaveLength(1);
    expect(result.unclaimed[0]?.name).toBe("a");
  });
});

describe("what the popup gets", () => {
  test("the label carries the section, so an error can be located", () => {
    expect(ringLabel(ring({ name: "Øki A", section: "§ 5, stk. 1" }))).toBe(
      "Øki A — § 5, stk. 1",
    );
  });

  test("an unnamed area still says which section it came from", () => {
    expect(ringLabel(ring({ name: null, section: "§ 3, stk. 4" }))).toBe(
      "§ 3, stk. 4",
    );
  });

  test("a seasonal closure says so, because nothing downstream can", () => {
    // `jmelding_geo` can express an absolute window and not a recurring one, so
    // a three-month spawning closure and a year-round ban land as the same row.
    // Until that changes the season has to survive in the one field that
    // reaches the shape the user actually clicks.
    expect(
      ringLabel(
        ring({
          name: "øki a",
          section: "§ 5, stk. 2",
          season: "1. september – 31. mai",
        }),
      ),
    ).toBe("øki a — § 5, stk. 2 (1. september – 31. mai)");
  });
});
