import { describe, expect, test } from "bun:test";
import type { UsableFragment } from "@/usable/client";
import { coordinateTextDetector, hasCoordinatesTagDetector } from "./detection";
import { formatSweepCounts, hashBody, rejectSweep, sweepCorpus } from "./sweep";

const DETECTORS = [coordinateTextDetector, hasCoordinatesTagDetector];

/**
 * A Lógasavn fragment as the REST list actually returns it — frontmatter and
 * all, because the frontmatter is half of what this module has to get right.
 */
function fragmentOf(input: {
  id: string;
  title?: string;
  authority?: string;
  validity?: string;
  scrapedAt?: string;
  body: string;
  tags?: string[];
}): UsableFragment {
  return {
    id: input.id,
    title: input.title ?? "Kunngerð nr. 35 (2026)",
    tags: input.tags ?? [],
    content: `---
url: https://logir.fo/Kunngerd/35-fra-2026
law_number: 35
validity_status: ${input.validity ?? "Galdandi"}
authority: ${input.authority ?? "Uttanríkis- og fiskimálaráðið"}
content_hash: sha256:0b5df14cd424a438c447acdfbac345ba1055413fa10a7135ee918cfb41fa8356
scraped_at: ${input.scrapedAt ?? "2026-07-24T06:00:24.616Z"}
---

${input.body}`,
  };
}

// Kunngerð 35/2026 § 2 — Føroyabanki, the area users ask for by name. Ten
// vertices, the last repeating the first to close the ring.
const FOROYABANKI_BODY = `### § 2.

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

// Kunngerð 29/2017 — electronic reporting formats. No geometry, correctly.
const NO_GEOMETRY_BODY = `### § 1.

 Skipini skulu senda inn upplýsingar í elektroniskum sniði til Vørn.`;

describe("hashBody", () => {
  // The trap this exists to avoid: Jaspur's ingest moves `scraped_at` on every
  // pass whether or not the law changed, so a whole-content hash would report
  // every statute in the corpus as re-scraped every single night.
  test("a re-scrape that changes only the frontmatter does not move the hash", () => {
    const before = sweepCorpus(
      [fragmentOf({ id: "f1", body: FOROYABANKI_BODY })],
      DETECTORS,
    );
    const after = sweepCorpus(
      [
        fragmentOf({
          id: "f1",
          body: FOROYABANKI_BODY,
          scrapedAt: "2026-08-03T04:02:43.000Z",
        }),
      ],
      DETECTORS,
    );

    expect(after.entries[0]?.contentHash).toBe(
      before.entries[0]?.contentHash as string,
    );
  });

  test("a single changed vertex moves the hash", () => {
    const changed = FOROYABANKI_BODY.replace(`60°57'20"N`, `60°57'21"N`);

    expect(hashBody(changed)).not.toBe(hashBody(FOROYABANKI_BODY));
  });

  test("the hash is over the body a human would read, verbatim", () => {
    // Pinned to a value computed INDEPENDENTLY of this code —
    // `printf '### \302\247 1.\n' | shasum -a 256` — so the test cannot agree
    // with a mistake by rederiving it. This is the value a reader diffing two
    // versions of the index is reading.
    expect(hashBody("### § 1.\n")).toBe(
      "709f77bdb094d8697cafebc0ff0d4ffb334f53601722aea2daf86c9d683e21fc",
    );
  });
});

describe("sweepCorpus", () => {
  test("reads a real statute into rings and vertices", () => {
    const result = sweepCorpus(
      [fragmentOf({ id: "f1", body: FOROYABANKI_BODY })],
      DETECTORS,
    );

    const candidate = result.entries[0];
    expect(candidate?.fragmentId).toBe("f1");
    expect(candidate?.ringCount).toBe(1);
    expect(candidate?.vertexCount).toBe(10);
    expect(candidate?.withheldCount).toBe(0);
    expect(candidate?.coordinateSignals).toBe(20);
    expect(candidate?.validityStatus).toBe("Galdandi");
  });

  test("prose with no coordinates is skipped, not indexed", () => {
    const result = sweepCorpus(
      [fragmentOf({ id: "f1", body: NO_GEOMETRY_BODY })],
      DETECTORS,
    );

    expect(result.entries).toEqual([]);
    expect(result.counts.skipped).toBe(1);
    expect(result.counts.candidates).toBe(0);
    // Counted regardless: "300 of 7,405" is the sentence the index opens with,
    // and it is only honest if the denominator is everything that was read.
    expect(result.counts.scanned).toBe(1);
  });

  test("counts every fragment it read, candidate or not", () => {
    const result = sweepCorpus(
      [
        fragmentOf({ id: "f1", body: FOROYABANKI_BODY }),
        fragmentOf({ id: "f2", body: NO_GEOMETRY_BODY }),
        fragmentOf({ id: "f3", body: NO_GEOMETRY_BODY }),
      ],
      DETECTORS,
    );

    expect(result.counts.scanned).toBe(3);
    expect(result.counts.candidates).toBe(1);
    expect(result.counts.inForceCandidates).toBe(1);
    expect(result.counts.skipped).toBe(2);
    expect(result.counts.rings).toBe(1);
    expect(result.counts.withheld).toBe(0);
    expect(result.counts.extractionGaps).toBe(0);
  });

  test("coordinates that yield no ring are counted as an extraction gap", () => {
    // A bounding-parallel descriptor: real coordinates, no enumerable ring.
    const result = sweepCorpus(
      [
        fragmentOf({
          id: "f1",
          body: "Økið norðan fyri breiddarstigið 62°25,000'N og vestan fyri 007°00,000'V.",
        }),
      ],
      DETECTORS,
    );

    expect(result.counts.candidates).toBe(1);
    expect(result.counts.rings).toBe(0);
    expect(result.counts.extractionGaps).toBe(1);
    expect(result.entries[0]?.coordinateSignals).toBe(2);
    expect(result.entries[0]?.ringCount).toBe(0);
  });

  test("prefers the normalised authority tag over the signing ministry", () => {
    // K 164/2020 is signed "Fiskimálaráðið" but tagged to the ministry that
    // holds the brief today — that is the one triage can rely on across
    // decades of reorganisations.
    const result = sweepCorpus(
      [
        fragmentOf({
          id: "f1",
          body: FOROYABANKI_BODY,
          authority: "Fiskimálaráðið",
          tags: ["authority:uttanrikis-og-fiskimalaradid", "topic:fisheries"],
        }),
      ],
      DETECTORS,
    );

    expect(result.entries[0]?.authority).toBe("uttanrikis-og-fiskimalaradid");
  });

  test("falls back to the frontmatter ministry when the tag says nobody", () => {
    const result = sweepCorpus(
      [
        fragmentOf({
          id: "f1",
          body: FOROYABANKI_BODY,
          authority: "Løgmansskrivstovan",
          tags: ["authority:eingin"],
        }),
      ],
      DETECTORS,
    );

    expect(result.entries[0]?.authority).toBe("Løgmansskrivstovan");
  });

  test("reports the inert cross-check rather than firing it 47 times", () => {
    const result = sweepCorpus(
      [fragmentOf({ id: "f1", body: FOROYABANKI_BODY })],
      DETECTORS,
    );

    expect(result.inertDetectors).toEqual(["has-coordinates-tag"]);
    expect(result.counts.disagreements).toBe(0);
  });
});

describe("rejectSweep", () => {
  // The failure this catches: a broken detector reports zero candidates and
  // publishes an empty index over a working one — freshly stamped, and
  // therefore more convincing than the stale page it replaced.
  test("a corpus that was read but yielded no candidate is refused", () => {
    const result = sweepCorpus(
      [
        fragmentOf({ id: "f1", body: NO_GEOMETRY_BODY }),
        fragmentOf({ id: "f2", body: NO_GEOMETRY_BODY }),
      ],
      DETECTORS,
    );

    expect(rejectSweep(result)).toContain("the detector is broken");
  });

  test("an empty fetch is refused", () => {
    expect(rejectSweep(sweepCorpus([], DETECTORS))).toContain(
      "swept 0 fragments",
    );
  });

  test("a sweep that found something is allowed to land", () => {
    const result = sweepCorpus(
      [fragmentOf({ id: "f1", body: FOROYABANKI_BODY })],
      DETECTORS,
    );

    expect(rejectSweep(result)).toBeNull();
  });
});

describe("formatSweepCounts", () => {
  test("prints the numbers that make a broken detector visible", () => {
    const result = sweepCorpus(
      [
        fragmentOf({ id: "f1", body: FOROYABANKI_BODY }),
        fragmentOf({ id: "f2", body: NO_GEOMETRY_BODY }),
      ],
      DETECTORS,
    );

    const line = formatSweepCounts(result);

    expect(line).toContain("scanned: 2");
    expect(line).toContain("candidates: 1 (1 in force)");
    expect(line).toContain("skipped: 1");
    expect(line).toContain("rings read: 1");
    expect(line).toContain("inert detectors: has-coordinates-tag");
  });
});

describe("in-force counting", () => {
  // A count, never a filter: the superseded statute is still swept, still
  // recorded, and still hashed — it just is not what a reader meets first.
  test("a superseded candidate is recorded but counted separately", () => {
    const result = sweepCorpus(
      [
        fragmentOf({ id: "f1", body: FOROYABANKI_BODY }),
        fragmentOf({
          id: "f2",
          body: FOROYABANKI_BODY,
          validity: "Áður galdandi",
        }),
      ],
      DETECTORS,
    );

    expect(result.counts.candidates).toBe(2);
    expect(result.counts.inForceCandidates).toBe(1);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]?.validityStatus).toBe("Áður galdandi");
  });
});
