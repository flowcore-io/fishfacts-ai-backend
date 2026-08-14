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
};

type VesselIndex = {
  byName: Map<string, VesselRow[]>;
  /** Compacted mark → id, or null where the mark is not unique. */
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
const ACTIVE_VESSEL_STATUS_ID = 1;

type VesselDbRow = RowDataPacket & {
  id: number;
  name: string | null;
  registration_number: string | null;
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
  const [rows] = await pool.query<VesselDbRow[]>(
    "SELECT id, name, registration_number, call_sign, mmsi FROM vessel WHERE vessel_status_id = ?",
    [ACTIVE_VESSEL_STATUS_ID],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    registrationNumber: row.registration_number,
    callSign: row.call_sign,
    mmsi: row.mmsi,
  }));
}

export function indexVessels(rows: VesselRow[]): VesselIndex {
  const byName = new Map<string, VesselRow[]>();
  const byMark = new Map<string, number | null>();
  for (const row of rows) {
    const name = normalizeVesselText(row.name);
    if (name) {
      const bucket = byName.get(name);
      if (bucket) bucket.push(row);
      else byName.set(name, [row]);
    }
    for (const mark of marksOf(row)) {
      const existing = byMark.get(mark);
      if (existing === undefined) byMark.set(mark, row.id);
      else if (existing !== row.id) byMark.set(mark, null);
    }
  }
  return { byName, byMark, loadedAt: Date.now() };
}

/**
 * Name first, mark as the tiebreak — the FE's precedence, with the tiebreak
 * the FE has no need for because it never sees two vessels of one name.
 *
 * Measured against the 150 distinct vessels named in the last 50 days of real
 * reports: 86 resolve by name, 6 more by name + mark, 4 by mark alone, 3 stay
 * ambiguous (2.0%) and 51 are absent from the registry entirely. Without the
 * mark tiebreak the ambiguous count is 9 (6.0%).
 */
export function resolveFromIndex(
  index: VesselIndex,
  name: string,
  mark: string,
): VesselLookup {
  const candidates = name ? (index.byName.get(name) ?? []) : [];
  const only = candidates[0];
  if (candidates.length === 1 && only) {
    return { outcome: "resolved", vesselId: only.id };
  }
  if (candidates.length > 1) {
    if (mark) {
      const hits = candidates.filter((row) => marksOf(row).includes(mark));
      const hit = hits[0];
      if (hits.length === 1 && hit) {
        return { outcome: "resolved", vesselId: hit.id };
      }
    }
    // Several vessels of this name and nothing to separate them. An arbitrary
    // pick here attaches a stranger's track to the report — the failure the
    // 150 km sanity flag exists to catch. Say we do not know.
    return { outcome: "not-found" };
  }
  // Name unknown (or absent): a mark unique across the registry still
  // identifies the vessel. Ambiguous marks are indexed as null.
  if (mark) {
    const byMark = index.byMark.get(mark);
    if (typeof byMark === "number") {
      return { outcome: "resolved", vesselId: byMark };
    }
  }
  return { outcome: "not-found" };
}

/** Every identifier a report's registration mark could legitimately match. */
function marksOf(row: VesselRow): string[] {
  return [
    compactMark(row.registrationNumber),
    compactMark(row.callSign),
    compactMark(row.mmsi),
  ].filter(Boolean);
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
 * Marks, unlike names, are punctuated differently on each side of the seam:
 * the journal writes `H -0190-S` and `VL-0028-ØN`, the registry stores
 * `F 0032BD`, `VL0024AV`, `N 0100S`. Same identifier, different spacing and
 * dashes — so marks are compared with the punctuation removed. Measured on
 * the real 50-day population, this is worth 10 of 150 vessels (6 by tiebreak,
 * 4 by mark alone); comparing them verbatim resolves NONE.
 */
export function compactMark(value: string | null | undefined): string {
  return normalizeVesselText(value).replace(/[\s\-_.]/g, "");
}

function countAmbiguousNames(index: VesselIndex): number {
  let count = 0;
  for (const rows of index.byName.values()) if (rows.length > 1) count += 1;
  return count;
}
