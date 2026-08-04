import { describe, expect, test } from "bun:test";
import { INDEX_FRAGMENT_KEY, buildIndexFragment } from "./index-fragment";
import type { IndexEntry, SweepResult } from "./sweep";

const SCANNED_AT = "2026-08-04T05:00:00.000Z";

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    fragmentId: "11111111-1111-4111-8111-111111111111",
    contentHash:
      "0b5df14cd424a438c447acdfbac345ba1055413fa10a7135ee918cfb41fa8356",
    title: "Kunngerð nr. 35 (2026)",
    url: "https://logir.fo/Kunngerd/35-fra-2026",
    authority: "uttanrikis-og-fiskimalaradid",
    validityStatus: "Galdandi",
    coordinateSignals: 20,
    ringCount: 1,
    vertexCount: 10,
    withheldCount: 0,
    detectorsDisagree: false,
    ...overrides,
  };
}

function resultOf(entries: IndexEntry[]): SweepResult {
  const inForce = entries.filter((e) => e.validityStatus === "Galdandi").length;
  return {
    counts: {
      scanned: 7405,
      candidates: entries.length,
      inForceCandidates: inForce,
      skipped: 7405 - entries.length,
      rings: entries.reduce((n, e) => n + e.ringCount, 0),
      withheld: entries.reduce((n, e) => n + e.withheldCount, 0),
      extractionGaps: 0,
      disagreements: 0,
    },
    entries,
    inertDetectors: ["has-coordinates-tag"],
  };
}

describe("the freshness contract", () => {
  // The single thing most likely to be got wrong about this index. It solves
  // scoping and does NOT solve recall over time: the corpus grows and is
  // re-scraped, so a page written today silently rots. A stale index is worse
  // than none, because it returns a complete-LOOKING list that is missing the
  // statute someone is asking about — and a cold search with no index at all
  // has already been shown to find everything that matters.
  const page = buildIndexFragment(resultOf([entry()]), SCANNED_AT);

  test("stamps the day it was scanned, machine-readably and in prose", () => {
    expect(page.content).toContain(`scanned_at: ${SCANNED_AT}`);
    expect(page.content).toContain("read on **2026-08-04**");
    expect(page.tags).toContain("scanned:2026-08-04");
  });

  test("tells the reader in as many words that the list is a floor", () => {
    expect(page.content).toContain("FLOOR, not a ceiling");
    expect(page.content).toContain("Do not stop here");
    expect(page.content).toContain("search the corpus directly as well");
  });

  test("says how far the stamp reaches, not merely that one exists", () => {
    // A date with no instruction attached is decoration. What makes it load
    // bearing is the sentence that names the date as the cut-off.
    expect(page.content).toContain(
      "If the question touches anything after 2026-08-04",
    );
  });

  test("never claims a listing means the statute is a closure", () => {
    expect(page.content).toContain("Nothing here is verified");
    expect(page.summary).toContain("not a complete list");
  });
});

describe("the parser's counts", () => {
  test("are published as a witness, with the case against them", () => {
    const page = buildIndexFragment(resultOf([entry()]), SCANNED_AT);

    // Both halves have to be on the page. The ten-vertex match is why the
    // numbers are worth reading; the thirteen fishing-ground tables are why
    // they may not be believed over a reading of the statute.
    expect(page.content).toContain("witness, never an author");
    expect(page.content).toContain("existing fishing grounds");
    expect(page.content).toContain("disagreement is a finding");
  });

  test("a statute the parser cannot read is still listed", () => {
    // K 102/2024's annex is decimal-degree tables: coordinate signals, zero
    // rings. Dropping it for being unparseable is the one failure recall
    // cannot survive.
    const page = buildIndexFragment(
      resultOf([
        entry({
          title: "Kunngerð nr. 102 (2024)",
          coordinateSignals: 47,
          ringCount: 0,
          vertexCount: 0,
        }),
      ]),
      SCANNED_AT,
    );

    expect(page.content).toContain("Kunngerð nr. 102 (2024)");
    expect(page.content).toContain("are not thereby empty");
  });
});

describe("the table", () => {
  test("separates in-force from superseded without hiding either", () => {
    const page = buildIndexFragment(
      resultOf([
        entry({ title: "In force one" }),
        entry({
          fragmentId: "22222222-2222-4222-8222-222222222222",
          title: "Superseded one",
          validityStatus: "Áður galdandi",
        }),
      ]),
      SCANNED_AT,
    );

    expect(page.content).toContain("## In force (`Galdandi`) — 1");
    expect(page.content).toContain("## Superseded or unknown validity — 1");
    expect(page.content).toContain("Superseded one");
  });

  test("carries the logir.fo link, because provenance is the whole feedback loop", () => {
    const page = buildIndexFragment(resultOf([entry()]), SCANNED_AT);

    expect(page.content).toContain(
      "[source](https://logir.fo/Kunngerd/35-fra-2026)",
    );
  });

  test("a title with a pipe cannot break the row it sits in", () => {
    const page = buildIndexFragment(
      resultOf([entry({ title: "Kunngerð | nr. 35" })]),
      SCANNED_AT,
    );

    expect(page.content).toContain("Kunngerð \\| nr. 35");
  });

  test("keys on something stable, so a re-run rewrites rather than piles up", () => {
    expect(buildIndexFragment(resultOf([entry()]), SCANNED_AT).key).toBe(
      INDEX_FRAGMENT_KEY,
    );
    expect(
      buildIndexFragment(resultOf([entry()]), "2026-09-01T05:00:00.000Z").key,
    ).toBe(INDEX_FRAGMENT_KEY);
  });
});
