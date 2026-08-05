import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import type { StatuteReading } from "@/logasavn/closure-reading";
import { buildIndexFragment } from "@/logasavn/index-fragment";
import type { StatuteReader } from "@/logasavn/reader";
import type { IndexEntry, SweepResult } from "@/logasavn/sweep";
import type { PathwayWriter } from "@/pathways";
import type { UsableFragment } from "@/usable/client";
import {
  FAROESE_WATERS_CATEGORY,
  INTERNATIONAL_WATERS_CATEGORY,
  type LogasavnClosuresUsable,
  categoryFor,
  createLogasavnClosuresJob,
  signatureFor,
  statuteNumberOf,
} from "./logasavn-closures";

const env = {
  USABLE_WORKSPACE_ID: "33333333-3333-4333-8333-333333333333",
  LOGASAVN_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
} as unknown as Env;

const context = {
  signal: new AbortController().signal,
  isStopRequested: () => false,
  reportProgress: () => {},
};

const STATUTE_FRAGMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
/** A second statute, so a failure on one can be shown not to end the run. */
const SECOND_FRAGMENT_ID = "bbbbbbbb-2222-4222-8222-222222222222";

/** K 30/2018 § 5 — `Øki A` closed all year, `øki a` reopened inside it. */
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

/** What a correct read of the fixture above looks like. */
const GOOD_READING: StatuteReading = {
  inForce: true,
  summary: "Øki A on Føroyabanki is closed to all gear all year.",
  rings: [
    {
      section: "§ 5, stk. 1",
      name: "Øki A",
      kind: "closure",
      season: null,
      vertices: OKI_A_QUOTES,
    },
    {
      section: "§ 5, stk. 2",
      name: "øki a",
      kind: "exemption",
      season: "1. september – 31. mai",
      vertices: LOWER_A_QUOTES,
    },
  ],
};

function indexEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    fragmentId: STATUTE_FRAGMENT_ID,
    contentHash: "0b5df14cd424",
    title: "Kunngerð nr. 30 (2018)",
    url: "https://logir.fo/Kunngerd/30-fra-2018",
    authority: "uttanrikis-og-fiskimalaradid",
    validityStatus: "Galdandi",
    coordinateSignals: 16,
    ringCount: 2,
    vertexCount: 8,
    withheldCount: 0,
    detectorsDisagree: false,
    ...overrides,
  };
}

function indexContent(entries: IndexEntry[]): string {
  const result: SweepResult = {
    counts: {
      scanned: 7405,
      candidates: entries.length,
      inForceCandidates: entries.filter((e) => e.validityStatus === "Galdandi")
        .length,
      skipped: 7405 - entries.length,
      rings: 0,
      withheld: 0,
      extractionGaps: 0,
      disagreements: 0,
    },
    entries,
    inertDetectors: [],
  };
  return buildIndexFragment(result, "2026-08-04T05:00:00.000Z").content;
}

function harness(options: {
  entries?: IndexEntry[];
  body?: string;
  reading?: StatuteReading;
  index?: UsableFragment | null;
}) {
  const emitted: JMeldingAnnouncementDiscovered[] = [];
  const readTitles: string[] = [];

  const usable: LogasavnClosuresUsable = {
    getFragmentByKey: async () =>
      options.index === undefined
        ? {
            id: "index-id",
            content: indexContent(options.entries ?? [indexEntry()]),
          }
        : options.index,
    getFragmentById: async (fragmentId) =>
      fragmentId === STATUTE_FRAGMENT_ID || fragmentId === SECOND_FRAGMENT_ID
        ? { id: fragmentId, content: options.body ?? OKI_A_AND_LOWER_A }
        : null,
  };

  const read: StatuteReader = async (statute) => {
    readTitles.push(statute.title);
    return options.reading ?? GOOD_READING;
  };

  const writer = {
    writeJMeldingAnnouncement: async (
      event: JMeldingAnnouncementDiscovered,
    ) => {
      emitted.push(event);
    },
  } as unknown as PathwayWriter;

  return { usable, read, writer, emitted, readTitles };
}

describe("what reaches the map", () => {
  test("emits sourceFragmentId, or the projector 'repairs' statute geometry", () => {
    // The single most important assertion in this file. `geo-projector.ts` skips
    // Vørn's ring repair only for rows carrying this field, and that repair can
    // silently move a vertex — the one failure class nothing downstream detects.
    // The field was dormant for a whole release, so nothing else guards it.
    const h = harness({});

    return createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context).then(() => {
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0]?.sourceFragmentId).toBe(STATUTE_FRAGMENT_ID);
      expect(h.emitted[0]?.region).toBe("FO");
    });
  });

  test("draws the closure and not the exemption inside it", async () => {
    const h = harness({});

    await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context);

    const areas = h.emitted[0]?.areas ?? [];
    expect(areas).toHaveLength(1);
    expect(areas[0]?.name).toBe("Øki A — § 5, stk. 1");
    // Values, not counts: 60°50,000'N = 60 + 50/60, and 007°57,000'V is west.
    expect(areas[0]?.points[0]?.lat).toBeCloseTo(60.8333333333, 9);
    expect(areas[0]?.points[0]?.lon).toBeCloseTo(-7.95, 9);
  });

  test("a ring the two readers disagree about is not emitted", async () => {
    // One vertex moved. The ring still closes and still has four corners.
    const moved = [...OKI_A_QUOTES];
    moved[1] = { lat: `61°03,500'N`, lon: `007°57,000'V` };
    const h = harness({
      reading: {
        ...GOOD_READING,
        rings: [
          { ...GOOD_READING.rings[0], vertices: moved } as never,
          GOOD_READING.rings[1] as never,
        ],
      },
    });

    await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context);

    expect(h.emitted).toEqual([]);
  });

  test("a superseded statute is read by nobody and drawn by nobody", async () => {
    const h = harness({
      entries: [indexEntry({ validityStatus: "Áður galdandi" })],
    });

    await expect(
      createLogasavnClosuresJob(
        env,
        h.writer,
        h.usable,
        h.read,
      )(undefined, { dryRun: false }, context),
    ).rejects.toThrow(/refusing to report a clean run over nothing/);
    expect(h.readTitles).toEqual([]);
  });

  test("the model calling a statute out of force overrides the index", async () => {
    // Two opinions about validity, and the cheaper one does not win. The index
    // is a scan; the reader has read § 17.
    const h = harness({ reading: { ...GOOD_READING, inForce: false } });

    await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context);

    expect(h.emitted).toEqual([]);
  });

  test("a dry run reads everything and writes nothing", async () => {
    const h = harness({});

    const result = await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: true }, context);

    expect(h.readTitles).toEqual(["Kunngerð nr. 30 (2018)"]);
    expect(h.emitted).toEqual([]);
    expect(result.message).toContain("Dry run");
    expect(result.message).toContain("rings drawn: 1");
  });
});

describe("the run summary is an instrument", () => {
  test("a correct declination is not counted as a disagreement", async () => {
    // The fixture yields one closure and one exemption. Reporting both under a
    // single `withheld` total makes a run that rightly refused the exemption
    // read like a run where the two readers fell out — which is the opposite of
    // what happened, and the reason `WithholdReason` separates them.
    const h = harness({});

    const result = await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: true }, context);

    expect(result.message).toContain("withheld (readers disagree): 0");
    expect(result.message).toContain("declined (not closures): 1");
  });

  test("a genuine disagreement lands in the withheld count, not the declined one", async () => {
    const moved = [...OKI_A_QUOTES];
    moved[1] = { lat: `61°03,500'N`, lon: `007°57,000'V` };
    const h = harness({
      reading: {
        ...GOOD_READING,
        rings: [
          { ...GOOD_READING.rings[0], vertices: moved } as never,
          GOOD_READING.rings[1] as never,
        ],
      },
    });

    const result = await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: true }, context);

    expect(result.message).toContain("withheld (readers disagree): 1");
    expect(result.message).toContain("declined (not closures): 1");
  });
});

describe("one flaky call costs one statute", () => {
  test("a reader that throws does not abandon the statutes after it", async () => {
    // A 429, a fenced or null `content`, a body that is not JSON. Unguarded,
    // the throw ends the run — and on a live run everything already emitted
    // stays emitted, so the map is half updated and the job only says it failed.
    const h = harness({
      entries: [
        indexEntry({ title: "Kunngerð nr. 30 (2018)" }),
        indexEntry({
          fragmentId: SECOND_FRAGMENT_ID,
          title: "Kunngerð nr. 45 (2022)",
        }),
      ],
    });
    let call = 0;
    const flaky: StatuteReader = async (statute) => {
      call += 1;
      if (call === 1) throw new Error("OpenRouter answered 429");
      return h.read(statute);
    };

    const result = await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      flaky,
    )(undefined, { dryRun: false }, context);

    // The second statute still drew, and the failure is reported rather than
    // being indistinguishable from a statute with nothing in it.
    expect(h.emitted).toHaveLength(1);
    expect(result.message).toContain("statutes not read: 1");
    expect(result.message).toContain("rings drawn: 1");
  });

  test("a throw from the compare step also costs only one statute", async () => {
    // The network call is the obvious flaky surface, but it is not the only
    // thing inside the loop that can throw. Neither `extractAreas` nor
    // `compareReading` throws on any input seen so far — which is a statement
    // about the corpus so far, and this pipeline has already been surprised
    // twice by a character nobody had met. Forced here with a reading whose
    // `vertices` is not iterable, standing in for whatever the next surprise is.
    const h = harness({
      entries: [
        indexEntry({ title: "Kunngerð nr. 30 (2018)" }),
        indexEntry({
          fragmentId: SECOND_FRAGMENT_ID,
          title: "Kunngerð nr. 45 (2022)",
        }),
      ],
    });
    let call = 0;
    const hostile: StatuteReader = async (statute) => {
      call += 1;
      if (call === 1) {
        return {
          ...GOOD_READING,
          rings: [{ ...GOOD_READING.rings[0], vertices: null }],
        } as unknown as StatuteReading;
      }
      return h.read(statute);
    };

    const result = await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      hostile,
    )(undefined, { dryRun: false }, context);

    expect(h.emitted).toHaveLength(1);
    expect(result.message).toContain("statutes not read: 1");
    expect(result.message).toContain("rings drawn: 1");
  });
});

describe("refusing to look clean", () => {
  test("a missing index is an error, not an empty run", async () => {
    // "The sweep is broken" and "the corpus holds no closures" must not produce
    // the same green run.
    const h = harness({ index: null });

    await expect(
      createLogasavnClosuresJob(
        env,
        h.writer,
        h.usable,
        h.read,
      )(undefined, { dryRun: true }, context),
    ).rejects.toThrow(/run logasavn-sweep before this job/);
  });

  test("naming statutes the index does not have is an error", async () => {
    const h = harness({});

    await expect(
      createLogasavnClosuresJob(
        env,
        h.writer,
        h.usable,
        h.read,
      )(undefined, { dryRun: true, statutes: ["999/2099"] }, context),
    ).rejects.toThrow(/999\/2099/);
  });
});

describe("what the popup gets to say", () => {
  test("the reader's plain-language line reaches the row, not just the body", async () => {
    // `jmelding_geo` keeps no body, so a summary carried only in `bodyMarkdown`
    // is discarded at projection and the popup is left with
    // `title - category (status)` — which cannot tell a skipper whether the
    // shape is a closure, a permit regime or a seasonal carve-out.
    const h = harness({});

    await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context);

    expect(h.emitted[0]?.summary).toBe(
      "Øki A on Føroyabanki is closed to all gear all year.",
    );
  });

  test("the logir.fo link travels with the row", async () => {
    const h = harness({});

    await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context);

    expect(h.emitted[0]?.url).toBe("https://logir.fo/Kunngerd/30-fra-2018");
  });
});

describe("Faroese water vs international water", () => {
  test("a Faroese-waters statute keeps the Faroese category", () => {
    expect(
      categoryFor(
        "Kunngerð nr. 30 frá 11. apríl 2018 um at friða ávísar leiðir í føroyskum sjógvi",
      ),
    ).toBe(FAROESE_WATERS_CATEGORY);
  });

  test("NEAFC, NAFO and altjóða sjógvi are separated out", () => {
    // 50 of the 76 rings drawn on the first live run were these — correct
    // geometry, correct law, and thousands of kilometres from the Faroes. They
    // must be distinguishable from a closure in Faroese water.
    for (const title of [
      "Kunngerð nr. 113 frá 11. desember 2014 um økisfriðingar í altjóða sjógvi í NEAFC",
      "Kunngerð nr. 197 frá 22. desember 2021 um økisfriðingar í NAFO-skipanarøkinum",
      "Kunngerð nr. 229 frá 30. desember 2025 um at skipa fiskiskapin eftir djúphavsfiski í altjóða sjógvi í NEAFC í 2026",
    ]) {
      expect(categoryFor(title)).toBe(INTERNATIONAL_WATERS_CATEGORY);
    }
  });

  test("the emitted row carries the category the title implies", async () => {
    const h = harness({
      entries: [
        indexEntry({
          title:
            "Kunngerð nr. 113 (2014) - um økisfriðingar í altjóða sjógvi í NEAFC",
        }),
      ],
    });

    await createLogasavnClosuresJob(
      env,
      h.writer,
      h.usable,
      h.read,
    )(undefined, { dryRun: false }, context);

    expect(h.emitted[0]?.category).toBe(INTERNATIONAL_WATERS_CATEGORY);
    // Region is unchanged — the Faroes publish these, and the enum has no third
    // option. Category is what makes them separable.
    expect(h.emitted[0]?.region).toBe("FO");
  });

  test("model prose cannot move the signature", async () => {
    // The signature is the pathway's re-emit SUPPRESSION key. `summary` and the
    // ring labels are LLM output, and this pipeline has been measured wobbling
    // run to run — one statute enumerated 8 rings on one pass and 5 on the next.
    // If prose drift flipped the signature, every statute would re-emit on every
    // run forever, growing the event stream for a change no reader could see.
    const runs = [];
    for (const reading of [
      GOOD_READING,
      { ...GOOD_READING, summary: "A completely different sentence entirely." },
      {
        ...GOOD_READING,
        rings: [
          { ...GOOD_READING.rings[0], section: "§ 5 stk 1", name: "OKI A" },
          GOOD_READING.rings[1],
        ],
      } as StatuteReading,
    ]) {
      const h = harness({ reading });
      await createLogasavnClosuresJob(
        env,
        h.writer,
        h.usable,
        h.read,
      )(undefined, { dryRun: false }, context);
      runs.push(h.emitted[0]);
    }

    expect(runs[0]?.signature).toBe(runs[1]?.signature);
    expect(runs[0]?.signature).toBe(runs[2]?.signature);
    // ...but the drifted prose still rides along on whatever does get emitted.
    expect(runs[1]?.summary).toBe("A completely different sentence entirely.");
  });

  test("moving a vertex DOES move the signature", () => {
    // The other half: suppression must not swallow a real geometry change.
    // Driven through `signatureFor` directly, with contentHash held IDENTICAL,
    // so the only difference is the vertex. Going through the job would also
    // change the statute body and therefore the hash, and the assertion would
    // pass on that account instead — proving less than it appears to.
    const base = {
      statuteNumber: "30/2018",
      contentHash: "identical-on-both-sides",
      category: FAROESE_WATERS_CATEGORY,
    };

    expect(
      signatureFor({
        ...base,
        areas: [{ points: [{ lat: 61.25, lon: -8.26 }] }],
      }),
    ).not.toBe(
      signatureFor({
        ...base,
        areas: [{ points: [{ lat: 61.26, lon: -8.26 }] }],
      }),
    );
  });

  test("re-categorising a statute changes its signature, so the fix lands", async () => {
    // The pathway suppresses a re-emit whose signature is unchanged. If the
    // category were left out of the signature, every already-ingested statute
    // would keep its old category forever and this fix would be inert.
    const faroese = harness({});
    const international = harness({
      entries: [
        indexEntry({ title: "Kunngerð nr. 30 (2018) - NEAFC altjóða sjógvi" }),
      ],
    });

    for (const h of [faroese, international]) {
      await createLogasavnClosuresJob(
        env,
        h.writer,
        h.usable,
        h.read,
      )(undefined, { dryRun: false }, context);
    }

    expect(faroese.emitted[0]?.signature).not.toBe(
      international.emitted[0]?.signature,
    );
  });
});

describe("the signature is pinned on purpose", () => {
  // A golden value, so nothing in the suppression key can drift unnoticed —
  // including SIGNATURE_VERSION, which is the ONLY thing that makes rows
  // already in production pick up a newly added column. Changing this test is
  // the deliberate act; changing it by accident is what it exists to prevent.
  test("hashes exactly these inputs, at this version", () => {
    expect(
      signatureFor({
        statuteNumber: "30/2018",
        contentHash: "abc",
        category: FAROESE_WATERS_CATEGORY,
        areas: [{ points: [{ lat: 1, lon: 2 }] }],
      }),
    ).toBe("8bbef33e92eda5393e05c455c1f9af8ff7164f4211da96c4483d68ede520010e");
  });

  test("a version bump re-emits every statute exactly once", () => {
    // Rows ingested before `summary`/`category` existed carry a v1 signature.
    // Without a differing signature the pathway suppresses the re-emit and the
    // new columns stay empty forever — the fix would ship and do nothing.
    const v1 =
      "313b9af40abb61d7f04da167e7649469da85e1f8b09dc8378e386358c12f5fc6";
    expect(
      signatureFor({
        statuteNumber: "30/2018",
        contentHash: "abc",
        category: FAROESE_WATERS_CATEGORY,
        areas: [{ points: [{ lat: 1, lon: 2 }] }],
      }),
    ).not.toBe(v1);
  });
});

describe("statute numbering", () => {
  test("reads the number and year out of a corpus title", () => {
    expect(statuteNumberOf("Kunngerð nr. 30 (2018)")).toBe("30/2018");
    expect(
      statuteNumberOf("Kunngerð nr. 113 um vernd av viðkvæmum havøkjum (2014)"),
    ).toBe("113/2014");
  });

  test("a title it cannot read is null rather than a guess", () => {
    expect(statuteNumberOf("Anordning om ikrafttræden")).toBeNull();
  });
});
