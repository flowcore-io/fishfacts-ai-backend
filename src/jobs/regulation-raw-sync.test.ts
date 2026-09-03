import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import type {
  RawSyncCaseRow,
  RegulationRawSyncRepository,
} from "@/regulations/queue-repository";
import { rawFragmentKeyFor } from "@/regulations/raw-fragment";
import {
  type RegulationRawSyncUsable,
  createRegulationRawSyncJob,
} from "./regulation-raw-sync";

const env = {
  USABLE_WORKSPACE_ID: "ws-knowledge",
  REGULATION_RAW_COLLECTION_ID: "10000000-0000-4000-8000-000000000001",
  REGULATION_RAW_FRAGMENT_TYPE_ID: "10000000-0000-4000-8000-000000000002",
} as Env;

function caseRow(overrides: Partial<RawSyncCaseRow> = {}): RawSyncCaseRow {
  return {
    caseKey: "fiskeridir-jmelding:J-1-2026",
    title: "Test J-1-2026",
    jurisdiction: "NO",
    sourceType: "fiskeridir-jmelding",
    sourceRef: "J-1-2026",
    sourceUrl: "https://www.fiskeridir.no/yrkesfiske/j-meldinger/J-1-2026",
    category: null,
    summary: null,
    sourceStatus: "current",
    changeType: "new",
    regulationStatus: "draft",
    adminStatus: "unread",
    verdictStatus: "ok",
    effectiveFrom: null,
    effectiveTo: null,
    currentRevisionId: "20000000-0000-4000-8000-000000000001",
    verdict: [
      { field: "§ 1", kind: "missing_expiry", ref: null, confidence: 0.7 },
    ],
    verdictRecordedAt: new Date("2026-09-03T12:00:00.000Z"),
    ...overrides,
  };
}

function harness(options: {
  cases: RawSyncCaseRow[];
  existingContent?: string;
  /** The lookup misses but the key exists — create answers 409. */
  conflictOnCreate?: boolean;
}) {
  const calls: Array<{ kind: "create" | "update"; input: unknown }> = [];
  let lookups = 0;
  const usable: RegulationRawSyncUsable = {
    getFragmentByKey: async () => {
      lookups += 1;
      if (options.conflictOnCreate) {
        // First lookup misses (the capped fallback list); the re-fetch after
        // the 409 finds it.
        return lookups === 1 ? null : { id: "frag-dup", title: "t" };
      }
      return options.existingContent === undefined
        ? null
        : { id: "frag-1", content: options.existingContent, title: "t" };
    },
    createFragment: async (input) => {
      if (options.conflictOnCreate) {
        throw new Error("Usable API HTTP 409: fragment key already exists");
      }
      calls.push({ kind: "create", input });
      return {};
    },
    updateFragment: async (_id, input) => {
      calls.push({ kind: "update", input });
      return {};
    },
  };
  const repository = {
    listCases: async () => options.cases,
    listGeometries: async () => [
      {
        position: 0,
        name: null,
        kind: "closure",
        season: null,
        points: [{ lat: 71.1666, lon: 24.8833 }],
        geometrySource: "enumerated",
      },
    ],
  } as never as RegulationRawSyncRepository;
  const run = createRegulationRawSyncJob(env, usable, repository);
  const context = {
    signal: new AbortController().signal,
    isStopRequested: () => false,
    reportProgress: () => {},
  };
  return { calls, run, context };
}

describe("regulation-raw-sync job", () => {
  test("creates a fragment in the RAW collection and nowhere else", async () => {
    const { calls, run, context } = harness({ cases: [caseRow()] });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("create");
    const input = calls[0]?.input as Record<string, unknown>;
    expect(input.collectionIds).toEqual([env.REGULATION_RAW_COLLECTION_ID]);
    expect(input.key).toBe(rawFragmentKeyFor("fiskeridir-jmelding:J-1-2026"));
    expect(input.tags).toContain("raw");
    // The content is parser output with an explicit warning, never a
    // user-facing record.
    expect(String(input.content)).toContain("RAW parser output");
    expect(String(input.content)).toContain("71.1666, 24.8833");
    expect(String(input.content)).toContain("`missing_expiry` at § 1");
    expect(result.changed).toBe(true);
  });

  test("skips a fragment already at the current revision and verdict", async () => {
    const item = caseRow();
    const { calls, run, context } = harness({
      cases: [item],
      existingContent: `---\ncaseKey: ${item.caseKey}\nrevisionId: ${item.currentRevisionId}\nverdictRecordedAt: 2026-09-03T12:00:00.000Z\nstate: raw\n---\n\nbody`,
    });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(result.message).toContain("already current: 1");
  });

  test("a 409 on create falls through to updating the existing fragment", async () => {
    const { calls, run, context } = harness({
      cases: [caseRow()],
      conflictOnCreate: true,
    });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("update");
    expect(result.message).toContain("updated: 1");
    expect(result.message).toContain("failed: 0");
  });

  test("updates a fragment whose verdict moved", async () => {
    const item = caseRow();
    const { calls, run, context } = harness({
      cases: [item],
      existingContent: `---\ncaseKey: ${item.caseKey}\nrevisionId: ${item.currentRevisionId}\nverdictRecordedAt: null\nstate: raw\n---\n\nbody`,
    });
    await run(undefined, {}, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("update");
    const input = calls[0]?.input as Record<string, unknown>;
    expect(input.collectionIds).toEqual([env.REGULATION_RAW_COLLECTION_ID]);
  });
});
