import { describe, expect, test } from "bun:test";
import type { RegistryRow } from "../../src/ais/activity-source";
import {
  REGISTRY_ROWS_QUERY,
  ensureVesselRegistry,
  feFlagCoverage,
  syncVesselRegistry,
  toRegistryRows,
} from "../../src/ais/vessel-registry";

function fakeRepo(size = 0) {
  const writes: Array<{ rows: RegistryRow[]; snapshotMs: number }> = [];
  return {
    writes,
    repository: {
      registrySize: async () => size,
      writeRegistrySnapshot: async (
        rows: RegistryRow[],
        snapshotMs: number,
      ) => {
        writes.push({ rows, snapshotMs });
      },
    },
  };
}

describe("vessel registry", () => {
  test("reads only the four columns it needs, every status", () => {
    expect(REGISTRY_ROWS_QUERY).toBe(
      "SELECT id, vessel_type_id, flag, name FROM vessel",
    );
  });

  test("registry SW becomes SE; padding and case are normalised; empty names are null", () => {
    const { rows, dropped } = toRegistryRows([
      { id: 1, vessel_type_id: 2, flag: "SW    ", name: "Ganthi" },
      { id: 2, vessel_type_id: 3, flag: "fo", name: "  " },
      { id: 3, vessel_type_id: null, flag: "NO", name: "x" },
      { id: 4, vessel_type_id: 5, flag: "", name: "y" },
    ]);
    expect(rows).toEqual([
      { vessel_id: 1, type_id: 2, flag: "SE", name: "Ganthi" },
      { vessel_id: 2, type_id: 3, flag: "FO", name: null },
    ]);
    expect(dropped).toBe(2);
  });

  test("names the FE flags that have no vessel behind them", () => {
    const { perFlag, missing } = feFlagCoverage([
      { vessel_id: 1, type_id: 2, flag: "FO", name: null },
      { vessel_id: 2, type_id: 2, flag: "SE", name: null },
      { vessel_id: 3, type_id: 2, flag: "CN", name: null },
    ]);
    expect(perFlag.FO).toBe(1);
    expect(perFlag.SE).toBe(1);
    expect(perFlag.CN).toBeUndefined();
    expect(missing).toEqual([
      "NO",
      "IS",
      "GL",
      "DK",
      "GB",
      "IE",
      "CA",
      "RU",
      "NZ",
    ]);
  });

  test("a sync writes one whole snapshot", async () => {
    const { writes, repository } = fakeRepo();
    const result = await syncVesselRegistry({
      repository,
      readSource: async () => [
        { id: 1, vessel_type_id: 2, flag: "FO", name: "A" },
      ],
      now: () => 42,
    });
    expect(result.written).toBe(1);
    expect(writes).toEqual([
      {
        rows: [{ vessel_id: 1, type_id: 2, flag: "FO", name: "A" }],
        snapshotMs: 42,
      },
    ]);
  });

  test("an empty read never replaces a good snapshot", async () => {
    const { writes, repository } = fakeRepo(15_000);
    await expect(
      syncVesselRegistry({ repository, readSource: async () => [] }),
    ).rejects.toThrow();
    expect(writes).toHaveLength(0);
  });

  test("boot fill runs only when the table is empty, and never throws", async () => {
    const full = fakeRepo(15_000);
    let reads = 0;
    await ensureVesselRegistry({
      repository: full.repository,
      readSource: async () => {
        reads++;
        return [];
      },
    });
    expect(reads).toBe(0);

    const empty = fakeRepo(0);
    await ensureVesselRegistry({
      repository: empty.repository,
      readSource: async () => {
        throw new Error("replica down");
      },
    });
    expect(empty.writes).toHaveLength(0);
  });
});
