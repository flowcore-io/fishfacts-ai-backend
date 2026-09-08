import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import { publishedFragmentKeyFor } from "@/regulations/published-fragment";
import type {
  PublishedRegulation,
  RegulationPublishedReadRepository,
} from "@/regulations/published-repository";
import {
  type RegulationPublishedSyncUsable,
  createRegulationPublishedSyncJob,
} from "./regulation-published-sync";

const env = {
  USABLE_WORKSPACE_ID: "ws-knowledge",
  REGULATION_PUBLISHED_COLLECTION_ID: "10000000-0000-4000-8000-000000000003",
  REGULATION_RAW_FRAGMENT_TYPE_ID: "10000000-0000-4000-8000-000000000002",
} as Env;

const PUBLISHED_AT = new Date("2026-09-08T10:00:00.000Z");

function publishedItem(
  overrides: Partial<PublishedRegulation> = {},
): PublishedRegulation {
  return {
    id: "b52ba6c8-2ee0-8f9a-8bd7-6a4d29e0f7c3",
    caseKey: "vorn-veidibann:14-2026",
    jurisdiction: "FO",
    sourceType: "vorn-veidibann",
    sourceUrl: "https://www.vorn.fo/veidibann-nr-14-2026",
    title: "Veiðibann nr. 14/2026",
    authority: "Vørn",
    regulationNumber: "14/2026",
    category: null,
    summary: "Closure on the western edge of Munkagrunnur.",
    applicability: null,
    seasonalRecurrence: null,
    interpretationNotes: null,
    effectiveFrom: null,
    effectiveTo: null,
    expiresAt: null,
    sourcePublishedAt: null,
    publishedAt: PUBLISHED_AT,
    publishedRevisionId: "20000000-0000-4000-8000-000000000001",
    metadataOnly: false,
    inForce: "current",
    geometries: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        position: 0,
        name: "Munkagrunnur vestari kantur",
        section: null,
        kind: "closure",
        season: null,
        points: [{ lat: 61.0667, lon: -7.0 }],
        geometrySource: "enumerated",
        coordinateSystem: "WGS84",
        precision: null,
      },
    ],
    ...overrides,
  };
}

function harness(options: {
  published: PublishedRegulation[];
  /** Total across ALL published cases; defaults to published.length. */
  publishedTotal?: number;
  withdrawn?: Array<{ caseKey: string; title: string }>;
  existingByKey?: Record<string, { id: string; content: string }>;
  collectionUnset?: boolean;
}) {
  const calls: Array<{ kind: "create" | "update"; input: unknown }> = [];
  const usable: RegulationPublishedSyncUsable = {
    getFragmentByKey: async (_workspaceId, key) => {
      const existing = options.existingByKey?.[key];
      return existing
        ? ({ id: existing.id, content: existing.content, title: "t" } as never)
        : null;
    },
    createFragment: async (input) => {
      calls.push({ kind: "create", input });
      return {};
    },
    updateFragment: async (_id, input) => {
      calls.push({ kind: "update", input });
      return {};
    },
  };
  const repository = {
    listPublished: async () => ({
      regulations: options.published,
      total: options.publishedTotal ?? options.published.length,
    }),
    listWithdrawn: async () => options.withdrawn ?? [],
  } as never as RegulationPublishedReadRepository;
  const run = createRegulationPublishedSyncJob(
    options.collectionUnset
      ? ({ ...env, REGULATION_PUBLISHED_COLLECTION_ID: "" } as Env)
      : env,
    usable,
    repository,
  );
  const context = {
    signal: new AbortController().signal,
    isStopRequested: () => false,
    reportProgress: () => {},
  };
  return { calls, run, context };
}

describe("regulation-published-sync job", () => {
  test("creates a fragment in the PUBLISHED collection carrying the pinned revision", async () => {
    const { calls, run, context } = harness({ published: [publishedItem()] });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("create");
    const input = calls[0]?.input as Record<string, unknown>;
    expect(input.collectionIds).toEqual([
      env.REGULATION_PUBLISHED_COLLECTION_ID,
    ]);
    expect(input.key).toBe(publishedFragmentKeyFor("vorn-veidibann:14-2026"));
    expect(input.tags).toContain("published");
    expect(String(input.content)).toContain("approved regulation");
    expect(String(input.content)).toContain("61.0667, -7");
    expect(String(input.content)).not.toContain("RAW parser output");
    expect(result.changed).toBe(true);
  });

  test("skips a fragment already at the pinned revision and publish stamp", async () => {
    const item = publishedItem();
    const key = publishedFragmentKeyFor(item.caseKey);
    const { calls, run, context } = harness({
      published: [item],
      existingByKey: {
        [key]: {
          id: "frag-1",
          content: `---\ncaseKey: ${item.caseKey}\nrevisionId: ${item.publishedRevisionId}\npublishedAt: ${PUBLISHED_AT.toISOString()}\nstate: published\n---\n\nbody`,
        },
      },
    });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(result.message).toContain("already current: 1");
  });

  test("re-publishes over a withdrawn tombstone when the case is approved again", async () => {
    const item = publishedItem();
    const key = publishedFragmentKeyFor(item.caseKey);
    const { calls, run, context } = harness({
      published: [item],
      existingByKey: {
        [key]: {
          id: "frag-1",
          content: `---\ncaseKey: ${item.caseKey}\nrevisionId: null\npublishedAt: null\nstate: withdrawn\n---\n\nbody`,
        },
      },
    });
    await run(undefined, {}, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("update");
    const input = calls[0]?.input as Record<string, unknown>;
    expect(input.collectionIds).toEqual([
      env.REGULATION_PUBLISHED_COLLECTION_ID,
    ]);
  });

  test("an un-published case's fragment becomes a tombstone OUTSIDE the collection", async () => {
    const withdrawn = { caseKey: "vorn-veidibann:9-2026", title: "Old ban" };
    const key = publishedFragmentKeyFor(withdrawn.caseKey);
    const { calls, run, context } = harness({
      published: [],
      withdrawn: [withdrawn],
      existingByKey: {
        [key]: {
          id: "frag-9",
          content: `---\ncaseKey: ${withdrawn.caseKey}\nrevisionId: r\npublishedAt: x\nstate: published\n---\n\nbody`,
        },
      },
    });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("update");
    const input = calls[0]?.input as Record<string, unknown>;
    // Leaving the collection IS the un-publish.
    expect(input.collectionIds).toEqual([]);
    expect(String(input.content)).toContain("state: withdrawn");
    expect(result.message).toContain("withdrawn: 1");
  });

  test("a withdrawn case that never synced, or already a tombstone, writes nothing", async () => {
    const alreadyWithdrawn = {
      caseKey: "vorn-veidibann:8-2026",
      title: "Older ban",
    };
    const { calls, run, context } = harness({
      published: [],
      withdrawn: [
        { caseKey: "vorn-veidibann:7-2026", title: "Never synced" },
        alreadyWithdrawn,
      ],
      existingByKey: {
        [publishedFragmentKeyFor(alreadyWithdrawn.caseKey)]: {
          id: "frag-8",
          content: `---\ncaseKey: ${alreadyWithdrawn.caseKey}\nrevisionId: null\npublishedAt: null\nstate: withdrawn\n---\n\nbody`,
        },
      },
    });
    const result = await run(undefined, {}, context);
    expect(calls).toHaveLength(0);
    expect(result.changed).toBe(false);
  });

  test("a capped run says it was truncated instead of passing as complete", async () => {
    const { run, context } = harness({
      published: [publishedItem()],
      publishedTotal: 500,
    });
    const result = await run(undefined, { limit: 1 }, context);
    expect(result.message).toContain("TRUNCATED");
    expect(result.message).toContain("of 500");
  });

  test("refuses to run without the published collection id", async () => {
    const { run, context } = harness({
      published: [publishedItem()],
      collectionUnset: true,
    });
    expect(run(undefined, {}, context)).rejects.toThrow(
      "REGULATION_PUBLISHED_COLLECTION_ID",
    );
  });
});
