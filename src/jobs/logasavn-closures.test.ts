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
  type LogasavnClosuresUsable,
  createLogasavnClosuresJob,
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
      fragmentId === STATUTE_FRAGMENT_ID
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
