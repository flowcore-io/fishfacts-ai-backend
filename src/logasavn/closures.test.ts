import { describe, expect, test } from "bun:test";
import type { ParsedArea } from "./areas";
import {
  type ClosureSource,
  LOGASAVN_KEY_PREFIX,
  closureKey,
  planClosureIngest,
} from "./closures";
import type { ReviewRow } from "./review";

const FRAGMENT = "bbbbbbbb-0000-4000-8000-000000000001";
const APPROVED_HASH = "a".repeat(64);

// Kunngerð 35/2026 § 2 — Føroyabanki's first three vertices, verbatim.
const FOROYABANKI_RING: ParsedArea = {
  name: null,
  points: [
    { lat: 60.955555555555556, lng: -7.95 },
    { lat: 61.05, lng: -7.95 },
    { lat: 61.25833333333333, lng: -8.266666666666667 },
  ],
  descriptorCount: 0,
  ringClosed: false,
  descriptive: false,
  unparsed: 0,
};

function approvedRow(over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    fragmentId: FRAGMENT,
    contentHash: APPROVED_HASH,
    isCurrent: true,
    title: "Kunngerð nr. 35 (2026) — Føroyabanki",
    authority: "uttanrikis-og-fiskimalaradid",
    validityStatus: "Galdandi",
    coordinateLike: 20,
    ringCount: 1,
    vertexCount: 10,
    withheldCount: 0,
    detectors: [],
    reviewStatus: "approved",
    reviewReason: "new_candidate",
    recurrence: null,
    reviewedBy: "gilli",
    reviewedAt: "2026-08-03T21:00:00.000Z",
    declineReason: null,
    firstSeenAt: "2026-08-03T05:00:00.000Z",
    lastSeenAt: "2026-08-03T05:00:00.000Z",
    ...over,
  };
}

function source(over: Partial<ClosureSource> = {}): ClosureSource {
  return {
    row: approvedRow(),
    body: "### § 2. …",
    contentHash: APPROVED_HASH,
    documentType: "Kunngerð",
    lawNumber: 35,
    year: 2026,
    url: "https://logir.fo/Kunngerd/35-fra-2026",
    areas: [FOROYABANKI_RING],
    ...over,
  };
}

describe("closureKey", () => {
  test("reads as the statute a human would name", () => {
    expect(
      closureKey({
        documentType: "Kunngerð",
        lawNumber: 35,
        year: 2026,
        fragmentId: FRAGMENT,
      }),
    ).toBe("LOG-K-35-2026");
  });

  test("distinguishes document types sharing a number and year", () => {
    const kunngerd = closureKey({
      documentType: "Kunngerð",
      lawNumber: 68,
      year: 2026,
      fragmentId: FRAGMENT,
    });
    const logtingslog = closureKey({
      documentType: "Løgtingslóg",
      lawNumber: 68,
      year: 2026,
      fragmentId: FRAGMENT,
    });

    // Colliding keys would silently overwrite one statute's geometry with
    // another's, and both would look fine.
    expect(kunngerd).not.toBe(logtingslog);
  });

  test("falls back to the fragment id rather than minting a colliding key", () => {
    expect(
      closureKey({
        documentType: null,
        lawNumber: null,
        year: null,
        fragmentId: FRAGMENT,
      }),
    ).toBe(`${LOGASAVN_KEY_PREFIX}-${FRAGMENT}`);
  });
});

describe("planClosureIngest", () => {
  test("draws an approved statute whose text still matches", () => {
    const plan = planClosureIngest([source()], []);

    expect(plan.emit).toHaveLength(1);
    expect(plan.skip).toEqual([]);
    expect(plan.emit[0]?.key).toBe("LOG-K-35-2026");
    expect(plan.emit[0]?.contentHash).toBe(APPROVED_HASH);
    // lng inside the parser, lon on the wire.
    expect(plan.emit[0]?.areas[0]?.points[0]).toEqual({
      lat: 60.955555555555556,
      lon: -7.95,
    });
  });

  // THE rule. The sweep runs daily and this job runs after it, so a statute can
  // be re-scraped between an approval and this moment. Drawing it then would use
  // an approval given for text nobody has read.
  test("withholds a statute whose text moved after it was approved", () => {
    const plan = planClosureIngest(
      [source({ contentHash: "d".repeat(64) })],
      [],
    );

    expect(plan.emit).toEqual([]);
    expect(plan.skip[0]?.reason).toBe("hash_moved");
  });

  test("withholds a fragment that could not be read at all", () => {
    const plan = planClosureIngest(
      [source({ body: null, contentHash: null })],
      [],
    );

    expect(plan.emit).toEqual([]);
    expect(plan.skip[0]?.reason).toBe("unreadable");
  });

  test("withholds an approved statute that now yields no ring", () => {
    const plan = planClosureIngest([source({ areas: [] })], []);

    expect(plan.emit).toEqual([]);
    expect(plan.skip[0]?.reason).toBe("no_geometry");
  });

  test("withholds a ring too short to be a polygon", () => {
    const twoPoints: ParsedArea = {
      ...FOROYABANKI_RING,
      points: FOROYABANKI_RING.points.slice(0, 2),
    };

    const plan = planClosureIngest([source({ areas: [twoPoints] })], []);

    expect(plan.emit).toEqual([]);
    expect(plan.skip[0]?.reason).toBe("no_geometry");
  });

  // Un-approved means not on the map, and that has to hold going backwards too:
  // a statute re-declined after being drawn must come off.
  test("retracts a drawn closure that is no longer approved", () => {
    const plan = planClosureIngest([], ["LOG-K-35-2026"]);

    expect(plan.retract).toEqual(["LOG-K-35-2026"]);
  });

  test("retracts a drawn closure whose text moved", () => {
    const plan = planClosureIngest(
      [source({ contentHash: "d".repeat(64) })],
      ["LOG-K-35-2026"],
    );

    // Skipped AND taken back down — leaving it drawn would keep showing
    // geometry from an approval that no longer applies.
    expect(plan.emit).toEqual([]);
    expect(plan.retract).toEqual(["LOG-K-35-2026"]);
  });

  test("leaves a still-approved closure drawn", () => {
    const plan = planClosureIngest([source()], ["LOG-K-35-2026"]);

    expect(plan.retract).toEqual([]);
    expect(plan.emit).toHaveLength(1);
  });

  // Vørn's emergency bans are region FO too. Archiving one because a statute
  // lost its approval would take a live closure off the map.
  test("never retracts a row it did not write", () => {
    const plan = planClosureIngest(
      [],
      ["J-2026-14", "vorn-ban-991", "LOG-K-1-2020"],
    );

    expect(plan.retract).toEqual(["LOG-K-1-2020"]);
  });
});
