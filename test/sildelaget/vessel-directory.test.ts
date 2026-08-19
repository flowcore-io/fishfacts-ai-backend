import { describe, expect, test } from "bun:test";
import {
  ACTIVE_VESSEL_STATUS_ID,
  ReplicaVesselDirectory,
  VESSEL_ROWS_QUERY,
  type VesselRow,
  compactMark,
  foldVesselName,
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
    harbourNumber: null,
    callSign: "LKQR",
    mmsi: "257123000",
  },
  // Two active vessels of one name — 197 of 11 942 names look like this.
  {
    id: 77,
    name: "Fiskebas",
    registrationNumber: null,
    harbourNumber: null,
    callSign: "LMAB",
    mmsi: "257000111",
  },
  {
    id: 78,
    name: "Fiskebas",
    registrationNumber: "VL0097B",
    harbourNumber: null,
    callSign: "LMCD",
    mmsi: "257000222",
  },
  {
    id: 7,
    name: "Havbris",
    registrationNumber: null,
    harbourNumber: null,
    callSign: "OZAA",
    mmsi: null,
  },
  // Vessel 433 as the replica really holds it: the mark is concatenated into
  // the name, `registration_number` is null, and `harbour_number` carries the
  // only copy of the mark — unpadded, where the journal writes `N -0905`.
  {
    id: 433,
    name: "Voyager N905",
    registrationNumber: null,
    harbourNumber: "N905",
    callSign: "MBMB8",
    mmsi: "232009818",
  },
  // A bare name and the same name carrying a mark, both in the registry at
  // once: the name as written must win. (Invented — the live registry holds
  // `Astrid S264` with no bare `Astrid` beside it.)
  {
    id: 620,
    name: "Nordstjerna",
    registrationNumber: null,
    harbourNumber: null,
    callSign: "LAAA",
    mmsi: "257000555",
  },
  {
    id: 621,
    name: "Nordstjerna T12",
    registrationNumber: null,
    harbourNumber: "T12",
    callSign: "LEEE",
    mmsi: "257000999",
  },
  {
    id: 3820,
    name: "Astrid S264",
    registrationNumber: null,
    harbourNumber: "S264",
    callSign: "LBBB",
    mmsi: "257000666",
  },
  // The journal writes `Astrid-Marie`, the registry `Astrid Marie`.
  {
    id: 3826,
    name: "Astrid Marie",
    registrationNumber: null,
    harbourNumber: "GG64",
    callSign: "LCCC",
    mmsi: "257000777",
  },
  // Two hulls of one name that only their harbour numbers separate.
  {
    id: 4101,
    name: "Nordlys",
    registrationNumber: null,
    harbourNumber: "M 0044 K",
    callSign: "LNAA",
    mmsi: "257000333",
  },
  {
    id: 4102,
    name: "Nordlys",
    registrationNumber: null,
    harbourNumber: "N 0088 V",
    callSign: "LNBB",
    mmsi: "257000444",
  },
  // The trap: this vessel's harbour number is the mark the report `Måsen
  // (R -0007-TV)` carries, and it is not Måsen.
  {
    id: 11240,
    name: "Anna v",
    registrationNumber: null,
    harbourNumber: "R 0007 TV",
    callSign: "LDDD",
    mmsi: "257000888",
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

describe("names the registry writes differently from the journal", () => {
  test("a name carrying the registration mark still matches the bare name", () => {
    // Vessel 433 — the case Gilli sent in: the report says `Voyager`, the
    // registry says `Voyager N905`, and exact matching bridges neither.
    expect(lookup("Voyager", "N -0905")).toEqual({
      outcome: "resolved",
      vesselId: 433,
    });
    // With no mark at all it is still the one row folding to `voyager`.
    expect(lookup("Voyager", null)).toEqual({
      outcome: "resolved",
      vesselId: 433,
    });
  });

  test("an exact name is never outvoted by a folded one", () => {
    // Both `Nordstjerna` and `Nordstjerna T12` are in the registry. The report
    // that says `Nordstjerna` means the vessel actually called that.
    expect(lookup("Nordstjerna", null)).toEqual({
      outcome: "resolved",
      vesselId: 620,
    });
    // And where only the mark-carrying form exists, the fold reaches it.
    expect(lookup("Astrid", "S -0264")).toEqual({
      outcome: "resolved",
      vesselId: 3820,
    });
  });

  test("a folded name never outranks the report's own mark", () => {
    // `LMAB` is vessel 77's call sign, which identifies one hull. A name that
    // only matches once it is folded is weaker evidence than that, so the
    // mark still gets its turn rather than being consumed by the fold.
    expect(lookup("Voyager", "LMAB")).toEqual({
      outcome: "resolved",
      vesselId: 77,
    });
    // Same for a folded name that reaches a candidate the mark disagrees with:
    // before folding existed this resolved on the mark, and it still does.
    expect(lookup("Astrid.", "T-0346-ND")).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });

  test("punctuation in a name is folded, but only as a fallback", () => {
    expect(lookup("Astrid-Marie", "GG-0064")).toEqual({
      outcome: "resolved",
      vesselId: 3826,
    });
    expect(foldVesselName("Astrid-Marie")).toBe("astrid marie");
    // The fold strips a trailing MARK, not a trailing number: these are names.
    expect(foldVesselName("Venarøy 2")).toBe("venarøy 2");
    expect(foldVesselName("Vastfjord II")).toBe("vastfjord ii");
  });
});

describe("harbour numbers confirm a name, and never resolve one", () => {
  test("a harbour number breaks a tie between two hulls of one name", () => {
    expect(lookup("Nordlys", null)).toEqual({ outcome: "not-found" });
    expect(lookup("Nordlys", "M -0044-K")).toEqual({
      outcome: "resolved",
      vesselId: 4101,
    });
  });

  test("a harbour number alone resolves nothing", () => {
    // Replayed on production this exact pair matched `Måsen (R -0007-TV)` to
    // vessel 11240 `Anna v` — a stranger's track on a customer's catch. The
    // mark index simply does not carry harbour numbers, so it cannot recur.
    expect(lookup("Måsen", "R -0007-TV")).toEqual({ outcome: "not-found" });
    expect(INDEX.byMark.has(compactMark("R -0007-TV"))).toBe(false);
    // A call sign, which identifies one hull, still resolves on its own.
    expect(lookup("Feilstavet Navn", "LDDD")).toEqual({
      outcome: "resolved",
      vesselId: 11240,
    });
  });
});

describe("marks the two sides pad differently", () => {
  test("zero padding is dropped from both sides before comparing", () => {
    // The journal pads (`N -0905`), the registry does not (`N905`).
    expect(compactMark("N -0905")).toBe(compactMark("N905"));
    expect(compactMark("VL-0024-AV")).toBe(compactMark("VL24AV"));
    // An MMSI is all digits with no letter in front, so it is left alone.
    expect(compactMark("232009818")).toBe("232009818");
  });
});

describe("the query sent to the production replica", () => {
  test("reads only active vessels, and only the matching columns", () => {
    // This statement never runs in tests (it needs the Cloud SQL pool), so it
    // is asserted directly — the same reason test/ais asserts the ClickHouse
    // SQL text. The status filter is not cosmetic: every measurement behind
    // the matching rules was taken over `vessel_status_id = 1`, and all 8 404
    // AIS-active vessel ids sampled carry it.
    expect(VESSEL_ROWS_QUERY).toContain("FROM vessel");
    expect(VESSEL_ROWS_QUERY).toContain("WHERE vessel_status_id = ?");
    expect(ACTIVE_VESSEL_STATUS_ID).toBe(1);
    for (const column of [
      "id",
      "name",
      "registration_number",
      // Added deliberately, and the reason is a customer report: vessel 433
      // carries its only identifier here (`harbour_number = "N905"`) and a
      // null registration number, so without this column it is unmatchable.
      "harbour_number",
      "call_sign",
      "mmsi",
    ]) {
      expect(VESSEL_ROWS_QUERY).toContain(column);
    }
    // Read-only, and one statement — never a per-report lookup.
    expect(VESSEL_ROWS_QUERY.toUpperCase()).toStartWith("SELECT ");
    expect(VESSEL_ROWS_QUERY).not.toContain(";");
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
