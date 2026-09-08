import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import {
  caseIdFor,
  geometryIdFor,
  revisionIdFor,
} from "../../src/regulations/ids";
import { RegulationPublishedReadRepository } from "../../src/regulations/published-repository";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_geometries WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'pub-test-%')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'pub-test-%')`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE 'pub-test-%'`;
}

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await cleanup(client);
  return { db, client };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Seed = {
  ref: string;
  jurisdiction?: string;
  /** null = never published. */
  published?: {
    metadataOnly?: boolean;
    /** Fields snapshot on the PINNED revision; null = pre-#172 revision
     * without one. */
    fields?: Record<string, unknown> | null;
    geometryPoints?: Array<{ lat: number; lon: number }>;
    daysAgo?: number;
  } | null;
  /** Case-column window (what the CURRENT draft says). */
  effectiveTo?: Date | null;
  effectiveFrom?: Date | null;
  /** A newer draft revision beyond the pinned one. */
  draftTitle?: string;
};

async function seedCase(db: NonNullable<typeof runCtx>["db"], seed: Seed) {
  const caseKey = `test-source:${seed.ref}`;
  const caseId = caseIdFor(caseKey);
  const publishedRevisionId = revisionIdFor(`${seed.ref}-rev-0`);
  const now = new Date(NOW);
  const draftRevisionId = seed.draftTitle
    ? revisionIdFor(`${seed.ref}-rev-1`)
    : null;
  await db.insert(schema.regulationCases).values({
    id: caseId,
    caseKey,
    sourceType: "test-source",
    sourceRef: seed.ref,
    jurisdiction: seed.jurisdiction ?? "FO",
    title: seed.draftTitle ?? `Published test ${seed.ref}`,
    sourceUrl: `https://example.test/${seed.ref}`,
    adminStatus: seed.published ? "published" : "under_review",
    regulationStatus: seed.published ? "published" : "draft",
    effectiveFrom: seed.effectiveFrom ?? null,
    effectiveTo: seed.effectiveTo ?? null,
    detectedBy: "test",
    firstSeenAt: now,
    lastCheckedAt: now,
    currentRevisionId: draftRevisionId ?? publishedRevisionId,
    ...(seed.published
      ? {
          publishedRevisionId,
          publishedToUsersAt: new Date(
            NOW - (seed.published.daysAgo ?? 0) * DAY,
          ),
          publishedToUsersBy: "admin:gilli",
          publishedMetadataOnly: seed.published.metadataOnly ?? false,
        }
      : {}),
  });
  await db.insert(schema.regulationCaseRevisions).values({
    id: publishedRevisionId,
    caseId,
    position: 0,
    changeType: "new",
    author: "collector:test",
    snapshotUrl: `https://example.test/${seed.ref}`,
    sourceEventSignature: `${seed.ref}-rev-0`,
    fields:
      seed.published?.fields === undefined ? null : seed.published?.fields,
  });
  if (draftRevisionId) {
    await db.insert(schema.regulationCaseRevisions).values({
      id: draftRevisionId,
      caseId,
      position: 1,
      changeType: "new",
      author: "admin:gilli",
      snapshotUrl: `https://example.test/${seed.ref}`,
      sourceEventSignature: `${seed.ref}-rev-1`,
    });
  }
  for (const [index, point] of (
    seed.published?.geometryPoints ?? []
  ).entries()) {
    await db.insert(schema.regulationCaseGeometries).values({
      id: geometryIdFor(publishedRevisionId, index),
      caseId,
      revisionId: publishedRevisionId,
      position: index,
      kind: "closure",
      points: [point],
      geometrySource: "enumerated",
    });
  }
  return { caseId, publishedRevisionId };
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[published-repository.test] skipping — could not connect to test PostGIS DB",
      error instanceof Error ? error.message : error,
    );
    runCtx = null;
  }
});

afterAll(async () => {
  if (runCtx) {
    await cleanup(runCtx.client);
    await runCtx.client.end();
  }
});

describe("RegulationPublishedReadRepository", () => {
  test("lists only published cases, serving the PINNED revision even while a draft drifts", async () => {
    if (!runCtx) return;
    const repository = new RegulationPublishedReadRepository(runCtx.db);
    const pinned = await seedCase(runCtx.db, {
      ref: "pub-test-pinned",
      published: {
        fields: {
          title: "Approved title",
          authority: "Vørn",
          regulationNumber: "14/2026",
          category: null,
          summary: "The approved reading.",
          effectiveFrom: null,
          effectiveTo: null,
          expiresAt: null,
          seasonalRecurrence: null,
          interpretationNotes: null,
          applicability: null,
        },
        geometryPoints: [{ lat: 61.05, lon: -7.0 }],
      },
      // The case columns carry the in-progress draft's title — users must
      // never see it.
      draftTitle: "DRAFT do not show",
    });
    await seedCase(runCtx.db, { ref: "pub-test-never", published: null });

    const { regulations, total } = await repository.listPublished({
      status: "all",
      limit: 50,
      offset: 0,
    });
    const keys = regulations.map((item) => item.caseKey);
    expect(keys).toContain("test-source:pub-test-pinned");
    expect(keys).not.toContain("test-source:pub-test-never");
    expect(total).toBe(regulations.length);

    const item = regulations.find(
      (entry) => entry.caseKey === "test-source:pub-test-pinned",
    );
    expect(item?.title).toBe("Approved title");
    expect(item?.authority).toBe("Vørn");
    expect(item?.publishedRevisionId).toBe(pinned.publishedRevisionId);
    expect(item?.geometries).toHaveLength(1);
    expect(item?.geometries[0]?.points[0]?.lat).toBe(61.05);
  });

  test("`current` hides expired and upcoming; the window comes from the pinned snapshot, not the draft", async () => {
    if (!runCtx) return;
    const repository = new RegulationPublishedReadRepository(runCtx.db);
    await seedCase(runCtx.db, {
      ref: "pub-test-expired",
      published: {
        fields: {
          title: "Expired ban",
          authority: null,
          regulationNumber: null,
          category: null,
          summary: null,
          effectiveFrom: new Date(NOW - 30 * DAY).toISOString(),
          effectiveTo: new Date(NOW - 10 * DAY).toISOString(),
          expiresAt: null,
          seasonalRecurrence: null,
          interpretationNotes: null,
          applicability: null,
        },
      },
      // The draft columns claim it never ends — the pinned snapshot rules.
      effectiveTo: null,
    });
    await seedCase(runCtx.db, {
      ref: "pub-test-open-window",
      published: { fields: null },
    });

    const current = await repository.listPublished({
      status: "current",
      limit: 50,
      offset: 0,
    });
    const currentKeys = current.regulations.map((item) => item.caseKey);
    expect(currentKeys).not.toContain("test-source:pub-test-expired");
    // No fields snapshot and no case window → in force (the jmelding rule).
    expect(currentKeys).toContain("test-source:pub-test-open-window");

    const all = await repository.listPublished({
      status: "all",
      limit: 50,
      offset: 0,
    });
    const expired = all.regulations.find(
      (item) => item.caseKey === "test-source:pub-test-expired",
    );
    expect(expired?.inForce).toBe("expired");
  });

  test("a snapshot missing a date key reads as null, never as the draft's case column", async () => {
    if (!runCtx) return;
    const repository = new RegulationPublishedReadRepository(runCtx.db);
    const seeded = await seedCase(runCtx.db, {
      ref: "pub-test-partial-snapshot",
      // A fields snapshot WITHOUT date keys; the case column meanwhile says
      // the regulation ended long ago (a draft could write that).
      published: { fields: { title: "Partial snapshot" } },
      effectiveTo: new Date(NOW - 10 * DAY),
    });
    const detail = await repository.getPublished(seeded.caseId);
    expect(detail?.effectiveTo).toBeNull();
    expect(detail?.inForce).toBe("current");
  });

  test("a metadata-only publish says so, and detail reads answer only for published cases", async () => {
    if (!runCtx) return;
    const repository = new RegulationPublishedReadRepository(runCtx.db);
    const metadataOnly = await seedCase(runCtx.db, {
      ref: "pub-test-metadata-only",
      published: { metadataOnly: true, fields: null },
    });
    const never = await seedCase(runCtx.db, {
      ref: "pub-test-hidden",
      published: null,
    });

    const detail = await repository.getPublished(metadataOnly.caseId);
    expect(detail?.metadataOnly).toBe(true);
    expect(detail?.geometries).toHaveLength(0);
    // A case in the queue but not published must read as nonexistent.
    expect(await repository.getPublished(never.caseId)).toBeNull();
  });
});
