/**
 * Vessel name / registration mark → FishFacts vessel id.
 *
 * Sildelaget reports name their vessel in words; AIS knows it only by
 * `location.vessel_id`. Something has to bridge the two before a report's
 * track can be looked up.
 *
 * The bridge is the `vessel` table on the FishFacts MySQL replica, read
 * through the AIS Cloud SQL pool — the same pool `financials/repository.ts`
 * reads `annual_report` and `company` through. `vessel.id` IS the keyspace our
 * AIS fixes are keyed by (checked: 500/500 distinct `location.vessel_id`
 * matched a `vessel.id`), so this is the authoritative mapping rather than a
 * lookalike, and it needs no credential the service does not already hold.
 */
import type { Env } from "@/env";
import type { RowDataPacket } from "mysql2";
import { getAisPool } from "../ais/mysql-pool";

/**
 * The outcome of a lookup. "not-found" and "unavailable" are deliberately
 * different answers: the first is knowledge about the vessel, the second is
 * the absence of knowledge about anything. Collapsing them is how a database
 * outage gets written into the read model as a permanent "no-vessel".
 */
export type VesselLookup =
  | { outcome: "resolved"; vesselId: number }
  /** The registry answered, and this vessel is not in it (or is ambiguous). */
  | { outcome: "not-found" }
  /** The registry could not be consulted — the caller must not conclude. */
  | { outcome: "unavailable"; reason: string };

/**
 * Bumped whenever these rules could give a report a DIFFERENT vessel than the
 * previous version did. It is hashed into every derived anchor's params
 * fingerprint (see `hashAnchorParams`), which is the only thing that re-derives
 * a report past AIS_ANCHOR_RETRY_WITHIN_DAYS: without a bump, a `no-vessel`
 * written a fortnight ago keeps its answer however much better the matching
 * gets. That reaches the job's whole 50-day window, which is also the window
 * the bubble map draws — so everything a customer can see is re-derived, and
 * only reports already off the map are left alone.
 *
 * 2 — harbour numbers read, registry names folded, marks unpadded (2026-08-19).
 */
export const VESSEL_MATCH_RULES_VERSION = 2;

export type VesselDirectory = {
  resolve(
    vesselName: string | null,
    registrationMark: string | null,
  ): Promise<VesselLookup>;
};

/** One registry row, reduced to the columns we match on. */
export type VesselRow = {
  id: number;
  name: string | null;
  /**
   * REGISTRY-SIDE NAME for the report's `registrationMark` — the same thing
   * under two names, and reading `registrationMark` off a registry row
   * silently yields undefined. Nullable, and mostly null: 10 182 of the 12 167
   * active rows carry none, which is why call sign and MMSI are matched too.
   */
  registrationNumber: string | null;
  /** NOT NULL on the replica. */
  callSign: string | null;
  mmsi: string | null;
  /**
   * The registry's OTHER mark column, and for some rows the only identifier
   * they carry: vessel 433 is `Voyager N905` with a null registration number
   * and `harbour_number = "N905"` — the mark the report writes as `N -0905`.
   * Weak on its own, though; see `marksOf`.
   */
  harbourNumber: string | null;
};

type VesselIndex = {
  /** Normalized name → rows, exactly as the report writes it. */
  byName: Map<string, VesselRow[]>;
  /** Folded name → rows, consulted only when `byName` has no answer. */
  byFoldedName: Map<string, VesselRow[]>;
  /**
   * Compacted STRONG mark → id, or null where the mark is not unique. Only
   * marks that may resolve a vessel on their own are indexed here — see
   * `strongMarksOf`.
   */
  byMark: Map<string, number | null>;
  loadedAt: number;
};

/**
 * Only vessels FishFacts still considers active. Measured: every one of the
 * 8 404 distinct `location.vessel_id` values in the most recent 20 000 fixes
 * has `vessel_status_id = 1`, so this excludes nothing a track could be found
 * for — while cutting name ambiguity from 3.21% of names (whole table) to
 * 1.65% (197 of 11 942).
 */
export const ACTIVE_VESSEL_STATUS_ID = 1;

/**
 * Exported so a test can assert what this service sends to a PRODUCTION
 * replica, the way test/ais guards the ClickHouse SQL: the columns the
 * matching depends on, and the status filter the ambiguity measurements
 * assume. Neither can be checked from the outside without a live pool.
 */
export const VESSEL_ROWS_QUERY =
  "SELECT id, name, registration_number, harbour_number, call_sign, mmsi FROM vessel WHERE vessel_status_id = ?";

type VesselDbRow = RowDataPacket & {
  id: number;
  name: string | null;
  registration_number: string | null;
  harbour_number: string | null;
  call_sign: string | null;
  mmsi: string | null;
};

/**
 * Reads the registry once per VESSEL_DIRECTORY_CACHE_TTL_MS and answers from
 * an in-memory index. One 12 000-row read an hour, never a query per report —
 * this is a production replica and the anchor job asks it thousands of times
 * an hour.
 *
 * Every failure path returns "unavailable" rather than "not-found", so a
 * dependency being down can never be recorded as a fact about a vessel.
 */
export class ReplicaVesselDirectory implements VesselDirectory {
  private index: VesselIndex | null = null;
  private loading: Promise<VesselIndex | { error: string }> | null = null;

  constructor(
    private readonly env: Env,
    /** Injectable for tests; defaults to the AIS replica pool. */
    private readonly readRows: () => Promise<VesselRow[]> = () =>
      readVesselRows(env),
  ) {}

  async resolve(
    vesselName: string | null,
    registrationMark: string | null,
  ): Promise<VesselLookup> {
    const name = normalizeVesselText(vesselName);
    const mark = compactMark(registrationMark);
    // Nothing to match on. Terminal: no registry, however healthy, could ever
    // answer this report.
    if (!name && !mark) return { outcome: "not-found" };

    const loaded = await this.load();
    if ("error" in loaded) {
      return { outcome: "unavailable", reason: loaded.error };
    }
    return resolveFromIndex(loaded, name, mark);
  }

  private async load(): Promise<VesselIndex | { error: string }> {
    const fresh =
      this.index &&
      Date.now() - this.index.loadedAt < this.env.VESSEL_DIRECTORY_CACHE_TTL_MS;
    if (fresh && this.index) return this.index;
    if (this.loading) return this.loading;

    this.loading = this.reload()
      .then((result) => {
        if (!("error" in result)) {
          this.index = result;
          return result;
        }
        // A failed refresh keeps serving the previous index: a stale registry
        // resolves far more reports than an empty one, and the rows it holds
        // were true when they were read.
        return this.index ?? result;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async reload(): Promise<VesselIndex | { error: string }> {
    try {
      const rows = await this.readRows();
      if (rows.length === 0) {
        // An empty registry is far likelier to be a broken read than a fleet
        // of none — treat it as no answer at all.
        return { error: "vessel registry returned no rows" };
      }
      const index = indexVessels(rows);
      // Logged per load so the ambiguity rate stays observable if it grows:
      // every ambiguous name is a report that only a mark can resolve.
      console.info("[Vessels] registry loaded", {
        vessels: rows.length,
        names: index.byName.size,
        ambiguousNames: countAmbiguousNames(index),
      });
      return index;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Vessels] registry read failed", { message });
      return { error: `vessel registry read failed: ${message}` };
    }
  }
}

/**
 * The whole active registry in one statement. Deliberately NOT a query per
 * report: 12 000 rows is a few MB held for an hour, against ~150 distinct
 * vessels named in a 50-day window — the read amortises immediately, and the
 * replica sees one scan an hour instead of thousands of point lookups.
 *
 * `backfill` pool role, never `live`: this is a scheduled job and it must not
 * take connections from the AIS tail (see ais/mysql-pool.ts).
 */
async function readVesselRows(env: Env): Promise<VesselRow[]> {
  const pool = await getAisPool(env, "backfill");
  const [rows] = await pool.query<VesselDbRow[]>(VESSEL_ROWS_QUERY, [
    ACTIVE_VESSEL_STATUS_ID,
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    registrationNumber: row.registration_number,
    callSign: row.call_sign,
    mmsi: row.mmsi,
    harbourNumber: row.harbour_number,
  }));
}

export function indexVessels(rows: VesselRow[]): VesselIndex {
  const byName = new Map<string, VesselRow[]>();
  const byFoldedName = new Map<string, VesselRow[]>();
  const byMark = new Map<string, number | null>();
  for (const row of rows) {
    addName(byName, normalizeVesselText(row.name), row);
    addName(byFoldedName, foldVesselName(row.name), row);
    // Only strong marks: a bare `harbour_number` must never be enough to name
    // a vessel, and this index is exactly the path that would let it.
    for (const mark of strongMarksOf(row)) {
      const existing = byMark.get(mark);
      if (existing === undefined) byMark.set(mark, row.id);
      else if (existing !== row.id) byMark.set(mark, null);
    }
  }
  return { byName, byFoldedName, byMark, loadedAt: Date.now() };
}

function addName(
  index: Map<string, VesselRow[]>,
  name: string,
  row: VesselRow,
): void {
  if (!name) return;
  const bucket = index.get(name);
  if (bucket) bucket.push(row);
  else index.set(name, [row]);
}

/**
 * Name first, mark as the tiebreak — the FE's precedence, with the tiebreak
 * the FE has no need for because it never sees two vessels of one name.
 *
 * Replayed 2026-08-19 over the 161 distinct (name, mark) pairs reported since
 * 2026-06-25, against the 12 152 status-1 registry rows, deployed chain
 * against this one:
 *
 *   resolved 106 -> 110    lost 0    resolved to a different vessel 0
 *
 * The four are `Voyager (N -0905)`, `Astrid (S -0264)` and `Quantus (PD-0379)`
 * — registry names carrying their own mark — and `Astrid-Marie (GG-0064)`,
 * which is `Astrid Marie` there. The 51 still unresolved all carry a Norwegian
 * county fiskerimerke (H, R, M, SF, TR, VL) and were searched five ways across
 * every status: they are absent from FishFacts' registry, which is a product
 * conversation rather than a matching one (`183e880c` in Usable).
 */
export function resolveFromIndex(
  index: VesselIndex,
  name: string,
  mark: string,
): VesselLookup {
  const named = name ? index.byName.get(name) : undefined;
  if (named) {
    const only = named[0];
    if (named.length === 1 && only) {
      return { outcome: "resolved", vesselId: only.id };
    }
    const agreed = markAgreement(named, mark);
    if (agreed) return { outcome: "resolved", vesselId: agreed.id };
    // Several vessels of this name and nothing to separate them. An arbitrary
    // pick here attaches a stranger's track to the report — the failure the
    // 150 km sanity flag exists to catch. Say we do not know.
    return { outcome: "not-found" };
  }

  // The name as the REGISTRY might have written it instead. This match is
  // approximate, so it does not outrank the mark: a report that carries one
  // has to be agreed with, and a folded candidate that cannot agree does not
  // consume the report — the mark gets its own turn below, where it used to
  // get it before folding existed.
  const folded = foldedNameCandidates(index, name);
  const onlyFolded = folded.length === 1 ? folded[0] : undefined;
  const agreedFolded = mark ? markAgreement(folded, mark) : onlyFolded;
  if (agreedFolded) return { outcome: "resolved", vesselId: agreedFolded.id };

  // Name unknown (or absent): a STRONG mark unique across the registry still
  // identifies the vessel. Ambiguous marks are indexed as null.
  if (mark) {
    const byMark = index.byMark.get(mark);
    if (typeof byMark === "number") {
      return { outcome: "resolved", vesselId: byMark };
    }
  }
  return { outcome: "not-found" };
}

/**
 * The one candidate the report's mark points at, if exactly one does. Two
 * candidates agreeing is no agreement at all.
 */
function markAgreement(
  candidates: VesselRow[],
  mark: string,
): VesselRow | undefined {
  if (!mark) return undefined;
  const hits = candidates.filter((row) => marksOf(row).includes(mark));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The rows whose name matches once the seam's cosmetic differences are folded
 * away. Only reached when the name as written matched nothing, so a vessel
 * really called `Nordstjerna` is never outvoted by `Nordstjerna T12`.
 */
function foldedNameCandidates(index: VesselIndex, name: string): VesselRow[] {
  if (!name) return [];
  const folded = foldVesselName(name);
  return folded ? (index.byFoldedName.get(folded) ?? []) : [];
}

/**
 * Identifiers issued to one hull, so a unique hit on one names the vessel by
 * itself: the registration number, the call sign and the MMSI.
 */
function strongMarksOf(row: VesselRow): string[] {
  return [
    compactMark(row.registrationNumber),
    compactMark(row.callSign),
    compactMark(row.mmsi),
  ].filter(Boolean);
}

/**
 * Every identifier a report's registration mark could legitimately match —
 * the strong ones plus `harbour_number`, which is only ever allowed to CONFIRM
 * a name that already matched (the tiebreak below), never to resolve alone.
 *
 * That restriction is measured, not cautious: replayed over the 51 unresolved
 * vessels, `harbour_number` on its own paired `Måsen (R -0007-TV)` with vessel
 * 11240 `Anna v`. A wrong hull draws a stranger's track onto a customer's
 * catch, which is strictly worse than drawing none.
 */
function marksOf(row: VesselRow): string[] {
  return [...strongMarksOf(row), compactMark(row.harbourNumber)].filter(
    Boolean,
  );
}

/**
 * Exactly fishfacts-fe's `normalizeVesselText` (sildelagetCatchActions.ts):
 * trimmed, lower-cased, nothing else. Names match across the two repos or the
 * FE and the backend disagree about which vessel a report is about.
 */
export function normalizeVesselText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

/**
 * A registration mark tacked onto the end of a registry name — `Voyager N905`,
 * `Astrid S264`, `Quantus PD 379`, `Gullberg VE-292`. 345 of the 12 157 active
 * names (2.8%) end in one, while the journal writes the bare name.
 *
 * One to three letters then two to six digits, anchored at the end: `Venarøy 2`
 * keeps its 2 (no letter prefix) and `Vastfjord II` keeps its numeral (no
 * digits), so ordinary names ending in a number survive the fold.
 */
const TRAILING_REGISTRATION_MARK = /\s+[a-z]{1,3}\s?\d{2,6}$/;

/**
 * The fallback form of a name, for the two ways the registry and the journal
 * write the same vessel differently: the registry concatenates the mark into
 * the name, and the two punctuate differently (`Astrid-Marie` against
 * `Astrid Marie`).
 *
 * NOT a change to `normalizeVesselText`, deliberately — that one has to stay
 * byte-identical to fishfacts-fe's copy. This is a backend-only widening of
 * which registry rows a name may reach, applied to both sides of the
 * comparison, and it is only consulted when the exact name found nothing.
 */
export function foldVesselName(value: string | null | undefined): string {
  const spaced = normalizeVesselText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return spaced.replace(TRAILING_REGISTRATION_MARK, "").trim();
}

/**
 * Marks, unlike names, are punctuated differently on each side of the seam:
 * the journal writes `H -0190-S` and `VL-0028-ØN`, the registry stores
 * `F 0032BD`, `VL0024AV`, `N 0100S`. Same identifier, different spacing and
 * dashes — so marks are compared with the punctuation removed. Measured on
 * the real 50-day population, this is worth 10 of 150 vessels (6 by tiebreak,
 * 4 by mark alone); comparing them verbatim resolves NONE.
 */
export function compactMark(value: string | null | undefined): string {
  return normalizeVesselText(value)
    .replace(/[\s\-_.]/g, "")
    .replace(LEADING_ZEROS_AFTER_LETTERS, "");
}

/**
 * The journal zero-pads a mark's number and the registry does not: `N -0905`
 * against `N905`, `GG-0064` against `PD 379`. Dropping the padding on both
 * sides is what makes them the same string. Anchored on a letter, so an MMSI
 * (`232009818`, all digits) is left alone.
 */
const LEADING_ZEROS_AFTER_LETTERS = /(?<=[a-z])0+(?=\d)/g;

function countAmbiguousNames(index: VesselIndex): number {
  let count = 0;
  for (const rows of index.byName.values()) if (rows.length > 1) count += 1;
  return count;
}
