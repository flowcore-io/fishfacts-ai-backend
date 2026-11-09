/**
 * FishFacts' vessel registry → ClickHouse `ais_vessel_registry`, for the
 * activity heatmap's type/flag join (activity-source.ts).
 *
 * Source: the `vessel` table on the FishFacts MySQL replica, through the
 * `backfill` role of the AIS pool — the same read `fishfacts/vessel-directory.ts`
 * makes, never connections from the live tail. `vessel.id` is the keyspace AIS
 * fixes are keyed by. All ~15.5 k rows, every status: the status says whether
 * FishFacts still lists a hull, not whether it fished in 2021.
 *
 * Refreshed daily by the `ais-vessel-registry` job, and at boot when the table
 * is empty — without a snapshot every activity answer would be empty, so the
 * routes refuse with 503 until one exists rather than cache an empty past.
 */
import type { Env } from "@/env";
import type { JobExecutionResult } from "@/jobs/types";
import type { RowDataPacket } from "mysql2";
import { ACTIVITY_DEFAULT_FLAGS, normaliseRegistryFlag } from "./activity";
import type { ClickhouseActivitySource, RegistryRow } from "./activity-source";
import { getAisPool } from "./mysql-pool";

/** Exported so a test can pin exactly what is sent to the production replica. */
export const REGISTRY_ROWS_QUERY =
  "SELECT id, vessel_type_id, flag, name FROM vessel";

export type RegistrySourceRow = {
  id: number;
  vessel_type_id: number | null;
  flag: string | null;
  name: string | null;
};

export async function readRegistrySourceRows(
  env: Env,
): Promise<RegistrySourceRow[]> {
  const pool = await getAisPool(env, "backfill");
  const [rows] =
    await pool.query<(RowDataPacket & RegistrySourceRow)[]>(
      REGISTRY_ROWS_QUERY,
    );
  return rows;
}

/**
 * Source rows → table rows. A row without a type or a flag cannot be placed on
 * the heatmap (both are part of its key), so it is dropped and counted rather
 * than given an invented one.
 */
export function toRegistryRows(source: RegistrySourceRow[]): {
  rows: RegistryRow[];
  dropped: number;
} {
  const rows: RegistryRow[] = [];
  let dropped = 0;
  for (const r of source) {
    const flag = normaliseRegistryFlag(r.flag);
    // Number(null) is 0, a type that does not exist — test for null first.
    const typeId =
      r.vessel_type_id == null ? Number.NaN : Number(r.vessel_type_id);
    if (!flag || !Number.isInteger(typeId) || !Number.isInteger(r.id)) {
      dropped++;
      continue;
    }
    const name = r.name?.trim();
    rows.push({ vessel_id: r.id, type_id: typeId, flag, name: name || null });
  }
  return { rows, dropped };
}

/**
 * Vessels per FE flag after mapping. A flag the FE offers with no vessel behind
 * it is a silent hole on the map (that is how Sweden read 0 h in the spike), so
 * the job says so in its result rather than leaving it to be noticed.
 */
export function feFlagCoverage(rows: RegistryRow[]): {
  perFlag: Record<string, number>;
  missing: string[];
} {
  const perFlag: Record<string, number> = {};
  for (const flag of ACTIVITY_DEFAULT_FLAGS) perFlag[flag] = 0;
  for (const row of rows) {
    if (Object.hasOwn(perFlag, row.flag))
      perFlag[row.flag] = (perFlag[row.flag] ?? 0) + 1;
  }
  const missing = ACTIVITY_DEFAULT_FLAGS.filter((f) => perFlag[f] === 0);
  return { perFlag, missing };
}

export type RegistrySyncDeps = {
  repository: Pick<
    ClickhouseActivitySource,
    "writeRegistrySnapshot" | "registrySize"
  >;
  readSource: () => Promise<RegistrySourceRow[]>;
  now?: () => number;
};

export async function syncVesselRegistry(
  deps: RegistrySyncDeps,
): Promise<{ written: number; dropped: number; missing: string[] }> {
  const source = await deps.readSource();
  const { rows, dropped } = toRegistryRows(source);
  if (rows.length === 0) {
    // An empty read is a broken read, not an empty registry: writing it would
    // replace a good snapshot with nothing and blank every heatmap.
    throw new Error("vessel registry read returned no usable rows");
  }
  await deps.repository.writeRegistrySnapshot(rows, (deps.now ?? Date.now)());
  const { missing } = feFlagCoverage(rows);
  if (missing.length > 0) {
    console.warn("[AIS] vessel registry has no vessels for FE flags", {
      missing,
    });
  }
  return { written: rows.length, dropped, missing };
}

/** The `ais-vessel-registry` job body. */
export function createVesselRegistryJob(deps: RegistrySyncDeps) {
  return async (): Promise<JobExecutionResult> => {
    const result = await syncVesselRegistry(deps);
    return {
      checkedAt: new Date().toISOString(),
      changed: true,
      latestItems: [],
      message: `registry snapshot: ${result.written} vessels (${result.dropped} dropped without type/flag)${
        result.missing.length
          ? `; no vessels for FE flags ${result.missing.join(",")}`
          : ""
      }`,
    };
  };
}

/** Boot: fill the table once if it has never been filled. Never throws. */
export async function ensureVesselRegistry(
  deps: RegistrySyncDeps,
): Promise<void> {
  try {
    if ((await deps.repository.registrySize()) > 0) return;
    const result = await syncVesselRegistry(deps);
    console.log("[AIS] vessel registry filled at boot", result);
  } catch (error) {
    console.error("[AIS] vessel registry boot fill failed (job will retry)", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
