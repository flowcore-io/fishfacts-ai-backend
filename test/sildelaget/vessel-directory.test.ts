import { describe, expect, test } from "bun:test";
import {
  ReplicaVesselDirectory,
  type VesselRow,
  compactMark,
  indexVessels,
  normalizeVesselText,
  resolveFromIndex,
} from "../../src/fishfacts/vessel-directory";

/**
 * Rows shaped like the live replica's `vessel` table. Registration numbers are
 * mostly NULL there (10 182 of 12 167 active rows), call signs never are, and
 * marks are punctuated differently from the journal's: the registry stores
 * `VL0024AV` / `F 0032BD`, the report writes `VL-0024-AV` / `F -0032-BD`.
 */
const ROWS: VesselRow[] = [
  {
    id: 932,
    name: "Brattskjær",
    registrationNumber: "T 0346ND",
    callSign: "LKQR",
    mmsi: "257123000",
  },
  // Two active vessels of one name — 197 of 11 942 names look like this.
  {
    id: 77,
    name: "Fiskebas",
    registrationNumber: null,
    callSign: "LMAB",
    mmsi: "257000111",
  },
  {
    id: 78,
    name: "Fiskebas",
    registrationNumber: "VL0097B",
    callSign: "LMCD",
    mmsi: "257000222",
  },
  {
    id: 7,
    name: "Havbris",
    registrationNumber: null,
    callSign: "OZAA",
    mmsi: null,
  },
];

const INDEX = indexVessels(ROWS);

function lookup(name: string | null, mark: string | null) {
  return resolveFromIndex(INDEX, normalizeVesselText(name), compactMark(mark));
}

function makeEnv(ttlMs = 3_600_000) {
  // biome-ignore lint/suspicious/noExplicitAny: env stub for the directory.
  return { VESSEL_DIRECTORY_CACHE_TTL_MS: ttlMs } as any;
}

describe("matching", () => {
  test("a unique name resolves", () => {
    expect(lookup("Brattskjær", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
    // Trim + lower-case, exactly as fishfacts-fe normalises before comparing.
    expect(lookup("  brattskjær ", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });

  test("a duplicated name is broken by the report's mark", () => {
    // Name alone cannot decide between vessel 77 and 78.
    expect(lookup("Fiskebas", null)).toEqual({ outcome: "not-found" });
    // The journal's punctuation differs from the registry's; comparing the
    // marks verbatim resolves nothing at all on real data.
    expect(lookup("Fiskebas", "VL-0097-B")).toEqual({
      outcome: "resolved",
      vesselId: 78,
    });
    // A call sign separates the row whose registration number is null — which
    // is most of them.
    expect(lookup("Fiskebas", "LMAB")).toEqual({
      outcome: "resolved",
      vesselId: 77,
    });
  });

  test("a mark that matches neither candidate leaves the name ambiguous", () => {
    expect(lookup("Fiskebas", "XX-9999-Z")).toEqual({ outcome: "not-found" });
  });

  test("an unknown name still resolves on a unique mark", () => {
    expect(lookup("Feilstavet Navn", "T-0346-ND")).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
    expect(lookup("Feilstavet Navn", "257123000")).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });

  test("a vessel absent from the registry is not-found, not a guess", () => {
    expect(lookup("Ukjent Skip", "ZZ-0001-Z")).toEqual({
      outcome: "not-found",
    });
  });

  test("a report with neither name nor mark is not-found", () => {
    expect(lookup(null, "   ")).toEqual({ outcome: "not-found" });
  });

  test("null registry marks never match a report that carries none", () => {
    // Havbris and Fiskebas(77) both have a null registrationNumber, and
    // Havbris has a null mmsi: an empty mark must not collide with them.
    expect(lookup("Havbris", "")).toEqual({ outcome: "resolved", vesselId: 7 });
    expect(lookup(null, "")).toEqual({ outcome: "not-found" });
    expect(INDEX.byMark.has("")).toBe(false);
  });
});

describe("the registry read", () => {
  test("is done once per TTL and shared by concurrent callers", async () => {
    let reads = 0;
    const directory = new ReplicaVesselDirectory(makeEnv(), async () => {
      reads += 1;
      return ROWS;
    });

    // The job resolves a whole batch at once; these must share one read, not
    // race into four queries against a production replica.
    await Promise.all([
      directory.resolve("Brattskjær", null),
      directory.resolve("Fiskebas", "VL-0097-B"),
      directory.resolve("Havbris", null),
    ]);
    await directory.resolve("Brattskjær", null);

    expect(reads).toBe(1);
  });

  test("re-reads once the TTL has passed", async () => {
    let reads = 0;
    const directory = new ReplicaVesselDirectory(makeEnv(1), async () => {
      reads += 1;
      return ROWS;
    });

    await directory.resolve("Brattskjær", null);
    await Bun.sleep(5);
    await directory.resolve("Brattskjær", null);

    expect(reads).toBe(2);
  });
});

describe("availability is not an answer", () => {
  test("a database error is unavailable, NOT not-found", async () => {
    const directory = new ReplicaVesselDirectory(makeEnv(), async () => {
      throw new Error("ECONNREFUSED");
    });

    const lookupResult = await directory.resolve("Brattskjær", "T-0346-ND");
    // As not-found this would be stored as a terminal "no-vessel" for every
    // report in the window the first time the replica hiccups.
    expect(lookupResult.outcome).toBe("unavailable");
    if (lookupResult.outcome === "unavailable") {
      expect(lookupResult.reason).toContain("ECONNREFUSED");
    }
  });

  test("an empty read is unavailable, not a fleet of none", async () => {
    const directory = new ReplicaVesselDirectory(makeEnv(), async () => []);

    expect((await directory.resolve("Brattskjær", null)).outcome).toBe(
      "unavailable",
    );
  });

  test("a later outage keeps serving the rows already read", async () => {
    let healthy = true;
    const directory = new ReplicaVesselDirectory(makeEnv(1), async () => {
      if (!healthy) throw new Error("replica down");
      return ROWS;
    });

    expect((await directory.resolve("Brattskjær", null)).outcome).toBe(
      "resolved",
    );
    healthy = false;
    await Bun.sleep(5);
    // Stale but true beats "we cannot say".
    expect(await directory.resolve("Brattskjær", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });
});
