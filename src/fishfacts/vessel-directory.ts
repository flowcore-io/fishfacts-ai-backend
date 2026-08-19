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
 * 3 — the non-active fleet answered as a second pass (2026-08-19).
 * 4 — a strong mark decides a name the active fleet cannot (2026-08-19).
 */
export const VESSEL_MATCH_RULES_VERSION = 4;

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
  /**
   * `vessel_status_id`. NOT NULL on the replica — checked, 0 null across all
   * 15 343 rows — so the `Number()` in `readVesselRows` always has an int to
   * read. If that ever stopped being true, `Number(null)` is 0 and the row
   * would land in the retired fleet: silent, but the safe direction, since
   * nothing there can outrank an active hull. See ACTIVE_VESSEL_STATUS_ID.
   */
  status: number;
};

/** One fleet's name and mark lookups. Built once per fleet, per registry read. */
type FleetIndex = {
  /** Normalized name → rows, exactly as the report writes it. */
  byName: Map<string, VesselRow[]>;
  /** Folded name → rows, consulted only when `byName` has no answer. */
  byFoldedName: Map<string, VesselRow[]>;
  /**
   * Compacted STRONG mark → the row, or null where the mark is not unique.
   * Only marks that may resolve a vessel on their own are indexed here — see
   * `strongMarksOf`. The row rather than the id, because a hull found by its
   * mark then has to be asked about its name.
   */
  byMark: Map<string, VesselRow | null>;
};

type VesselIndex = {
  active: FleetIndex;
  /**
   * Everything else in the registry. Asked only after the active fleet has
   * been asked and had no candidate at all — see `resolveFromIndex`.
   */
  inactive: FleetIndex;
  loadedAt: number;
};

/**
 * The fleet FishFacts still lists as active, and in practice the fleet it
 * receives AIS for: every one of the 8 404 distinct `location.vessel_id`
 * values in the most recent 20 000 fixes has `vessel_status_id = 1`.
 *
 * So this is the fleet a TRACK can be found for, and it is asked first. It is
 * no longer the fleet a vessel can be RECOGNISED in: `Joton` sits at status 4
 * under its exact name and its exact mark while landing 8 t of mackerel, and
 * telling its skipper he is absent from FishFacts' registry is simply false.
 */
export const ACTIVE_VESSEL_STATUS_ID = 1;

/**
 * Exported so a test can assert what this service sends to a PRODUCTION
 * replica, the way test/ais guards the ClickHouse SQL: the columns the
 * matching depends on. Cannot be checked from the outside without a live pool.
 *
 * Every row, every status — the status is now a column we rank on rather than
 * a predicate we filter by, so the split happens in `indexVessels` where it
 * can be reasoned about. Costs 15 343 rows read instead of 12 153, once an
 * hour.
 */
export const VESSEL_ROWS_QUERY =
  "SELECT id, name, registration_number, harbour_number, call_sign, mmsi, vessel_status_id FROM vessel";

type VesselDbRow = RowDataPacket & {
  id: number;
  name: string | null;
  registration_number: string | null;
  harbour_number: string | null;
  call_sign: string | null;
  mmsi: string | null;
  vessel_status_id: number;
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
        names: index.active.byName.size,
        ambiguousNames: countAmbiguousNames(index.active),
        retiredNames: index.inactive.byName.size,
        retiredAmbiguousNames: countAmbiguousNames(index.inactive),
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
 * The whole registry in one statement. Deliberately NOT a query per report:
 * 15 000 rows is a few MB held for an hour, against ~150 distinct vessels
 * named in a 50-day window — the read amortises immediately, and the replica
 * sees one scan an hour instead of thousands of point lookups.
 *
 * `backfill` pool role, never `live`: this is a scheduled job and it must not
 * take connections from the AIS tail (see ais/mysql-pool.ts).
 */
async function readVesselRows(env: Env): Promise<VesselRow[]> {
  const pool = await getAisPool(env, "backfill");
  const [rows] = await pool.query<VesselDbRow[]>(VESSEL_ROWS_QUERY);
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    registrationNumber: row.registration_number,
    callSign: row.call_sign,
    mmsi: row.mmsi,
    harbourNumber: row.harbour_number,
    status: Number(row.vessel_status_id),
  }));
}

export function indexVessels(rows: VesselRow[]): VesselIndex {
  const isActive = (row: VesselRow) => row.status === ACTIVE_VESSEL_STATUS_ID;
  return {
    active: indexFleet(rows.filter(isActive)),
    inactive: indexFleet(rows.filter((row) => !isActive(row))),
    loadedAt: Date.now(),
  };
}

function indexFleet(rows: VesselRow[]): FleetIndex {
  const byName = new Map<string, VesselRow[]>();
  const byFoldedName = new Map<string, VesselRow[]>();
  const byMark = new Map<string, VesselRow | null>();
  for (const row of rows) {
    addName(byName, normalizeVesselText(row.name), row);
    addName(byFoldedName, foldVesselName(row.name), row);
    // Only strong marks: a bare `harbour_number` must never be enough to name
    // a vessel, and this index is exactly the path that would let it.
    for (const mark of strongMarksOf(row)) {
      const existing = byMark.get(mark);
      if (existing === undefined) byMark.set(mark, row);
      else if (existing?.id !== row.id) byMark.set(mark, null);
    }
  }
  return { byName, byFoldedName, byMark };
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
 * 2026-06-25, each version against the version deployed before it:
 *
 *   v1 -> v2  (marks, folded names)   resolved 106 -> 110   lost 0   changed 0
 *   v2 -> v3  (the retired fleet)     resolved 110 -> 126   lost 0   changed 0
 *   v3 -> v4  (strong-mark tiebreak)  resolved 126 -> 127   lost 0   changed 0
 *
 * v2's four are `Voyager (N -0905)`, `Astrid (S -0264)`, `Quantus (PD-0379)` —
 * registry names carrying their own mark — and `Astrid-Marie (GG-0064)`, which
 * is `Astrid Marie` there.
 *
 * v3's sixteen are boats at status 3 or 4, and only ONE of them has an AIS fix
 * inside the job's 50-day window. So this pass buys almost no tracks: what it
 * buys is 16 reports that stop being told their vessel is absent from a
 * registry it is sitting in, and get `no-track` instead — the true answer.
 *
 * v4's one is `Harengus (H -0130-B)`, 2 reports: two active `Harengus` neither
 * of which carries the mark, and the Norwegian one retired at status 3 holding
 * it as `registration_number`. The same replay confirms `Måsen (R -0007-TV)`
 * still does NOT resolve — its only claim on vessel 11240 `Anna v` is a
 * harbour number, which this rule cannot read.
 *
 * The 34 that remain carry a Norwegian county fiskerimerke and were searched
 * five ways across every status: they are genuinely absent from FishFacts'
 * registry, which is a product conversation rather than a matching one
 * (`183e880c` in Usable).
 */
export function resolveFromIndex(
  index: VesselIndex,
  name: string,
  mark: string,
): VesselLookup {
  const active = matchWithin(index.active, name, mark);
  if (active.kind === "resolved") {
    return { outcome: "resolved", vesselId: active.id };
  }
  // The report's mark names several active hulls, so it is not an identifier
  // in this registry at all. Nothing may be answered on it.
  if (active.kind === "ambiguous-mark") return { outcome: "not-found" };

  // Several active hulls of this name. A retired NAMESAKE cannot settle that
  // — reaching past live hulls into a retired one would answer a question we
  // have just said we cannot answer, and a hull retired mid-window still
  // carries fixes inside the lookback. But the report's own mark can settle
  // it, if it is a strong one naming exactly one retired hull.
  //
  // `Harengus (H -0130-B)` is the case: two active `Harengus`, one Panamanian
  // and one Latvian, neither carrying the mark, while `Harengus H-130-B` sits
  // at status 3 with `registration_number H0130B`. Only the strong-mark index
  // is consulted, never the names, and that is what keeps `Måsen (R -0007-TV)`
  // out — vessel 11240 `Anna v` carries that mark in `harbour_number` alone,
  // and harbour numbers are not in this index.
  if (active.kind === "ambiguous-name") {
    const hull = mark ? index.inactive.byMark.get(mark) : null;
    // BOTH agreements are required. The mark alone would resolve a report
    // named `Fiskebas` to a retired hull called something else entirely,
    // which is the same over-reach one fleet over.
    if (hull && answersToName(hull, name)) {
      return { outcome: "resolved", vesselId: hull.id };
    }
    return { outcome: "not-found" };
  }

  // The active fleet has no candidate at all. `Joton` is here: status 4, no
  // AIS since ever, and in the registry under its exact name and its exact
  // mark while landing 8 t of mackerel. Resolving it does not produce a track
  // — it produces `no-track`, which is the true answer, in place of a
  // `no-vessel` that told its skipper he was absent from the registry.
  const retired = matchWithin(index.inactive, name, mark);
  if (retired.kind === "resolved") {
    return { outcome: "resolved", vesselId: retired.id };
  }
  return { outcome: "not-found" };
}

/**
 * Why one fleet answered as it did. Three ways of saying "no id", and the
 * differences decide what another fleet is allowed to answer.
 *
 * `none` — nothing here pointed at anything. Ask the next fleet anything.
 *
 * `ambiguous-name` — several hulls of this name, and nothing separated them.
 * The next fleet may not answer by NAME, because a namesake cannot settle a
 * doubt about namesakes — but a strong mark still can, since a registration
 * number, call sign or MMSI belongs to one hull where a name belongs to many.
 *
 * `ambiguous-mark` — the report's mark names several hulls here, so the mark
 * is not an identifier in this registry. Nothing may be answered on it.
 *
 * A single candidate that merely DISAGREES is none of these: that is evidence
 * against this fleet, and the next may be asked freely.
 */
type FleetMatch =
  | { kind: "resolved"; id: number }
  | { kind: "ambiguous-name" }
  | { kind: "ambiguous-mark" }
  | { kind: "none" };

/**
 * The chain, run against one fleet. Resolution WITHIN a fleet is unchanged in
 * behaviour since v2 — every rule fires exactly where it did, and no rule can
 * reach a hull it could not reach before. What v3 and v4 added is that each
 * way of failing says WHICH failure it was, because that is what decides how
 * far the next fleet may be trusted.
 */
function matchWithin(
  fleet: FleetIndex,
  name: string,
  mark: string,
): FleetMatch {
  const named = name ? fleet.byName.get(name) : undefined;
  if (named) {
    const only = named[0];
    if (named.length === 1 && only) return { kind: "resolved", id: only.id };
    const agreed = markAgreement(named, mark);
    if (agreed) return { kind: "resolved", id: agreed.id };
    // Several vessels of this name and nothing to separate them. This stops
    // HERE, without consulting this fleet's mark index: a mark that names
    // some third hull of another name entirely is not what this report is
    // about, and resolving to it would draw a stranger's track. What the
    // caller may still do with this answer is narrower — see
    // `resolveFromIndex`.
    return { kind: "ambiguous-name" };
  }

  // The name as the REGISTRY might have written it instead. This match is
  // approximate, so it does not outrank the mark: a report that carries one
  // has to be agreed with, and a folded candidate that cannot agree does not
  // consume the report — the mark gets its own turn below, where it used to
  // get it before folding existed.
  const folded = foldedNameCandidates(fleet, name);
  const onlyFolded = folded.length === 1 ? folded[0] : undefined;
  const agreedFolded = mark ? markAgreement(folded, mark) : onlyFolded;
  if (agreedFolded) return { kind: "resolved", id: agreedFolded.id };
  // Several folded candidates, none of which the mark singles out. The mark
  // still gets its turn below — but the doubt is remembered, because these
  // are live hulls this report might be about, and the next fleet must not
  // be allowed to talk over them.
  const undecided = folded.length > 1;

  // Name unknown (or absent): a STRONG mark unique across this fleet still
  // identifies the vessel.
  if (mark) {
    const hull = fleet.byMark.get(mark);
    if (hull) return { kind: "resolved", id: hull.id };
    // Indexed as null: this mark names more than one hull in this fleet. Same
    // doubt, and no other fleet is any way to settle it.
    if (hull === null) return { kind: "ambiguous-mark" };
  }
  return undecided ? { kind: "ambiguous-name" } : { kind: "none" };
}

/**
 * Does this registry row answer to the report's name? Equal once folded — or
 * the report's name followed by THIS HULL'S OWN MARK, which is the registry's
 * habit of writing the mark into the name (`Harengus H-130-B`). The fold
 * strips such a mark only when it ends in digits, so `Voyager N905` never
 * reaches here and `Harengus H-130-B` needs to.
 *
 * The tail has to be the mark and not merely a further word. Without that,
 * `Nordkapp` answers to `Nordkapp Junior` and the name agreement is spurious
 * — leaving the resolution resting on the mark alone, which is precisely the
 * over-reach this function exists to prevent. `X` / `X Junior` / `X II` pairs
 * are ordinary, and this registry holds `Astrid` and `Astrid Marie` as two
 * separate hulls.
 */
function answersToName(row: VesselRow, name: string): boolean {
  const wanted = foldVesselName(name);
  const found = foldVesselName(row.name);
  if (!wanted || !found) return false;
  if (found === wanted) return true;
  if (!found.startsWith(`${wanted} `)) return false;
  const tail = found.slice(wanted.length + 1);
  return marksOf(row).includes(compactMark(tail));
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
function foldedNameCandidates(fleet: FleetIndex, name: string): VesselRow[] {
  if (!name) return [];
  const folded = foldVesselName(name);
  return folded ? (fleet.byFoldedName.get(folded) ?? []) : [];
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

function countAmbiguousNames(fleet: FleetIndex): number {
  let count = 0;
  for (const rows of fleet.byName.values()) if (rows.length > 1) count += 1;
  return count;
}
