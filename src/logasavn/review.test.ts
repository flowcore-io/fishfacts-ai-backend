import { describe, expect, test } from "bun:test";
import type { DetectorVerdict } from "./detection";
import {
  type ObservedCandidate,
  type ReviewRow,
  hasExtractionGap,
  mergeReviewRows,
} from "./review";

const TEXT_HIT: DetectorVerdict = {
  detectorId: "coordinate-text",
  candidate: true,
  signal: 20,
};
const TAG_MISS: DetectorVerdict = {
  detectorId: "has-coordinates-tag",
  candidate: false,
  signal: 0,
};

const FRAGMENT = "9d1b1f4c-0000-4000-8000-000000000001";
const T0 = "2026-08-01T05:00:00.000Z";
const T1 = "2026-08-02T05:00:00.000Z";
const T2 = "2026-08-03T05:00:00.000Z";

function observed(
  overrides: Partial<ObservedCandidate> = {},
): ObservedCandidate {
  return {
    fragmentId: FRAGMENT,
    contentHash: "hash-of-2026-text",
    title: "Kunngerð nr. 35 (2026) — Føroyabanki",
    authority: "uttanrikis-og-fiskimalaradid",
    validityStatus: "Galdandi",
    coordinateLike: 20,
    ringCount: 1,
    vertexCount: 10,
    withheldCount: 0,
    detectors: [TEXT_HIT],
    ...overrides,
  };
}

/** One sweep that looked at exactly the fragments it reports candidates for. */
function sweepOf(candidates: ObservedCandidate[]) {
  return {
    scannedFragmentIds: new Set(candidates.map((c) => c.fragmentId)),
    observed: candidates,
  };
}

function approve(row: ReviewRow, at: string): ReviewRow {
  return {
    ...row,
    reviewStatus: "approved",
    reviewedBy: "gilli",
    reviewedAt: at,
  };
}

const currentOf = (rows: ReviewRow[]) => rows.filter((row) => row.isCurrent);

describe("mergeReviewRows — the hash pin", () => {
  test("a first sighting lands pending, never drawable by default", () => {
    const rows = mergeReviewRows([], sweepOf([observed()]), T0);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewStatus).toBe("pending");
    expect(rows[0]?.reviewReason).toBe("new_candidate");
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[0]?.recurrence).toBeNull();
    expect(rows[0]?.firstSeenAt).toBe(T0);
  });

  test("an unchanged hash keeps its approval across sweeps", () => {
    const approved = approve(
      mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow,
      T1,
    );

    const rows = mergeReviewRows([approved], sweepOf([observed()]), T2);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewStatus).toBe("approved");
    expect(rows[0]?.reviewedBy).toBe("gilli");
    expect(rows[0]?.reviewedAt).toBe(T1);
    // Still the same statute, seen again today.
    expect(rows[0]?.firstSeenAt).toBe(T0);
    expect(rows[0]?.lastSeenAt).toBe(T2);
  });

  // THE property. An approval is given for a specific text; when the text moves
  // the approval must stop applying, or it decays into "someone once said yes
  // to something".
  test("a moved content hash returns the fragment to pending", () => {
    const approved = approve(
      mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow,
      T1,
    );

    const rows = mergeReviewRows(
      [approved],
      sweepOf([observed({ contentHash: "hash-after-rescrape" })]),
      T2,
    );

    const current = currentOf(rows);
    expect(current).toHaveLength(1);
    expect(current[0]?.contentHash).toBe("hash-after-rescrape");
    expect(current[0]?.reviewStatus).toBe("pending");
    expect(current[0]?.reviewReason).toBe("source_changed");
    expect(current[0]?.reviewedBy).toBeNull();

    // The old verdict is retired, not destroyed.
    const retired = rows.filter((row) => !row.isCurrent);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.contentHash).toBe("hash-of-2026-text");
    expect(retired[0]?.reviewStatus).toBe("approved");
  });

  test("text that reverts to a previously approved hash is approved again", () => {
    const approved = approve(
      mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow,
      T0,
    );
    const afterChange = mergeReviewRows(
      [approved],
      sweepOf([observed({ contentHash: "hash-after-rescrape" })]),
      T1,
    );

    const afterRevert = mergeReviewRows(afterChange, sweepOf([observed()]), T2);

    const current = currentOf(afterRevert);
    expect(current).toHaveLength(1);
    expect(current[0]?.contentHash).toBe("hash-of-2026-text");
    // The approval was given for exactly this text, so it still holds — a
    // flapping scrape must not cost a reviewer the same decision twice.
    expect(current[0]?.reviewStatus).toBe("approved");
  });

  test("a scanned fragment that stops being a candidate goes dark", () => {
    const approved = approve(
      mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow,
      T0,
    );

    const rows = mergeReviewRows(
      [approved],
      { scannedFragmentIds: new Set([FRAGMENT]), observed: [] },
      T1,
    );

    expect(currentOf(rows)).toHaveLength(0);
    expect(rows[0]?.reviewStatus).toBe("approved");
  });

  // The guard against a truncated sweep blanking the map: a fragment this run
  // never read is not evidence that its statute vanished.
  test("a fragment outside the sweep is left untouched, not retired", () => {
    const approved = approve(
      mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow,
      T0,
    );
    const other = observed({
      fragmentId: "9d1b1f4c-0000-4000-8000-000000000002",
      contentHash: "hash-other",
    });

    const rows = mergeReviewRows([approved], sweepOf([other]), T1);

    // Absent from the result means absent from the write: the stored approval
    // survives untouched, still current and still drawable.
    expect(rows.some((row) => row.fragmentId === FRAGMENT)).toBe(false);
    expect(rows.map((row) => row.fragmentId)).toEqual([other.fragmentId]);
  });

  test("the sweep never rewrites a verdict a human gave", () => {
    const declined: ReviewRow = {
      ...(mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow),
      reviewStatus: "declined",
      declineReason: "treaty boundary, not a fishing closure",
      recurrence: { type: "annual", from: "02-01", to: "05-01" },
    };

    const rows = mergeReviewRows([declined], sweepOf([observed()]), T1);

    expect(rows[0]?.reviewStatus).toBe("declined");
    expect(rows[0]?.declineReason).toBe(
      "treaty boundary, not a fishing closure",
    );
    expect(rows[0]?.recurrence).toEqual({
      type: "annual",
      from: "02-01",
      to: "05-01",
    });
  });

  test("sweep-measured fields are refreshed on an existing row", () => {
    const first = mergeReviewRows(
      [],
      sweepOf([observed()]),
      T0,
    )[0] as ReviewRow;

    const rows = mergeReviewRows(
      [first],
      sweepOf([
        observed({
          title: "Kunngerð nr. 35 (2026) — Føroyabanki, broytt",
          validityStatus: "Áður galdandi",
          vertexCount: 13,
        }),
      ]),
      T1,
    );

    expect(rows[0]?.title).toBe("Kunngerð nr. 35 (2026) — Føroyabanki, broytt");
    expect(rows[0]?.vertexCount).toBe(13);
    // Supersession is a temporal fact for the read model, not a geometry
    // change, so it refreshes without re-opening the verdict.
    expect(rows[0]?.validityStatus).toBe("Áður galdandi");
    expect(rows[0]?.reviewStatus).toBe("pending");
  });
});

describe("mergeReviewRows — why a row is queued", () => {
  test("coordinates seen but no ring produced reads as unreadable geometry", () => {
    const rows = mergeReviewRows(
      [],
      sweepOf([observed({ coordinateLike: 43, ringCount: 0, vertexCount: 0 })]),
      T0,
    );

    expect(rows[0]?.reviewReason).toBe("unreadable_geometry");
  });

  test("a withheld area reads as unreadable geometry even when rings were drawn", () => {
    // K 197/2021: 3 of 18 areas readable. The 15 it could not read are the
    // reason it must not be approved on the strength of the 3 it could.
    const rows = mergeReviewRows(
      [],
      sweepOf([observed({ ringCount: 3, withheldCount: 15 })]),
      T0,
    );

    expect(rows[0]?.reviewReason).toBe("unreadable_geometry");
  });

  test("detectors that differ read as a cross-check disagreement", () => {
    const rows = mergeReviewRows(
      [],
      sweepOf([observed({ detectors: [TEXT_HIT, TAG_MISS] })]),
      T0,
    );

    expect(rows[0]?.reviewReason).toBe("crosscheck_disagreement");
  });

  test("a source change outranks every other reason", () => {
    const first = mergeReviewRows(
      [],
      sweepOf([observed()]),
      T0,
    )[0] as ReviewRow;

    const rows = mergeReviewRows(
      [first],
      sweepOf([
        observed({
          contentHash: "hash-after-rescrape",
          ringCount: 0,
          detectors: [TEXT_HIT, TAG_MISS],
        }),
      ]),
      T1,
    );

    // Whatever else is wrong with it, "did the law change" is the question
    // that has to be settled first.
    expect(currentOf(rows)[0]?.reviewReason).toBe("source_changed");
  });

  test("a pending row's reason tracks what the parser can see today", () => {
    const first = mergeReviewRows(
      [],
      sweepOf([observed()]),
      T0,
    )[0] as ReviewRow;
    expect(first.reviewReason).toBe("new_candidate");

    const rows = mergeReviewRows(
      [first],
      sweepOf([observed({ ringCount: 0, vertexCount: 0 })]),
      T1,
    );

    expect(rows[0]?.reviewReason).toBe("unreadable_geometry");
  });

  test("an answered row's reason is history and stays put", () => {
    const approved = approve(
      mergeReviewRows([], sweepOf([observed()]), T0)[0] as ReviewRow,
      T0,
    );

    const rows = mergeReviewRows(
      [approved],
      sweepOf([observed({ ringCount: 0, vertexCount: 0 })]),
      T1,
    );

    expect(rows[0]?.reviewReason).toBe("new_candidate");
  });
});

describe("hasExtractionGap", () => {
  test("prose with no coordinates and no rings is not a gap", () => {
    // K 29/2017 (electronic reporting formats) — correctly yields nothing.
    expect(
      hasExtractionGap(observed({ coordinateLike: 0, ringCount: 0 })),
    ).toBe(false);
  });

  test("coordinates present, nothing extracted, is the gap", () => {
    expect(
      hasExtractionGap(observed({ coordinateLike: 106, ringCount: 0 })),
    ).toBe(true);
  });

  test("a clean full parse is not a gap", () => {
    expect(
      hasExtractionGap(
        observed({ coordinateLike: 20, ringCount: 1, withheldCount: 0 }),
      ),
    ).toBe(false);
  });
});
