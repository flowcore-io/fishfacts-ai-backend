import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import {
  caseIdFor,
  geometryIdFor,
  revisionIdFor,
} from "../../src/regulations/ids";
import { RegulationQueueReadRepository } from "../../src/regulations/read-repository";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_links WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'qread-test-%')`;
  await client`DELETE FROM regulation_case_geometries WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'qread-test-%')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'qread-test-%')`;
  await client`DELETE FROM regulation_case_sources WHERE source_ref LIKE 'qread-test-%'`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE 'qread-test-%'`;
}

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await cleanup(client);
  return { db, client };
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

type CaseSeed = {
  ref: string;
  jurisdiction?: string;
  adminStatus?: string;
  urgency?: string | null;
  isRead?: boolean;
  assignee?: string | null;
  snoozeUntil?: Date | null;
  /** Hours before NOW the case was queued — larger = older. */
  queuedHoursAgo: number;
};

async function seedCase(db: NonNullable<typeof runCtx>["db"], seed: CaseSeed) {
  const caseKey = `test-source:${seed.ref}`;
  const caseId = caseIdFor(caseKey);
  const revisionId = revisionIdFor(`${seed.ref}-rev-0`);
  const queuedAt = new Date(NOW - seed.queuedHoursAgo * HOUR);
  await db.insert(schema.regulationCases).values({
    id: caseId,
    caseKey,
    sourceType: "test-source",
    sourceRef: seed.ref,
    jurisdiction: seed.jurisdiction ?? "FO",
    title: `Queue read test ${seed.ref}`,
    sourceUrl: `https://example.test/${seed.ref}`,
    adminStatus: seed.adminStatus ?? "unread",
    urgency: seed.urgency ?? null,
    isRead: seed.isRead ?? false,
    assignee: seed.assignee ?? null,
    snoozeUntil: seed.snoozeUntil ?? null,
    detectedBy: "test",
    firstSeenAt: queuedAt,
    lastCheckedAt: queuedAt,
    currentRevisionId: revisionId,
  });
  await db.insert(schema.regulationCaseRevisions).values({
    id: revisionId,
    caseId,
    position: 0,
    changeType: "new",
    author: "collector:test",
    snapshotUrl: `https://example.test/${seed.ref}`,
    sourceEventSignature: `${seed.ref}-rev-0`,
  });
  return { caseId, revisionId };
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[queue-read-repository.test] skipping — could not connect to test PostGIS DB",
      error instanceof Error ? error.message : error,
    );
    runCtx = null;
  }
  if (!runCtx) return;
  const { db } = runCtx;
  // The inbox population every list/count test reads against.
  await seedCase(db, {
    ref: "qread-test-critical-read",
    urgency: "critical",
    isRead: true,
    adminStatus: "under_review",
    assignee: "gilli",
    queuedHoursAgo: 100,
  });
  await seedCase(db, {
    ref: "qread-test-newest",
    jurisdiction: "NO",
    queuedHoursAgo: 1,
  });
  await seedCase(db, {
    ref: "qread-test-older",
    jurisdiction: "IS",
    queuedHoursAgo: 10,
  });
  await seedCase(db, {
    ref: "qread-test-snoozed",
    snoozeUntil: new Date(NOW + HOUR),
    queuedHoursAgo: 2,
  });
  await seedCase(db, {
    ref: "qread-test-snooze-expired",
    snoozeUntil: new Date(NOW - HOUR),
    queuedHoursAgo: 5,
  });
});

afterAll(async () => {
  if (runCtx) {
    await cleanup(runCtx.client);
    await runCtx.client.end();
  }
});

/** Only this test's rows — the shared test DB holds other suites' cases. */
const ours = (cases: Array<{ caseKey: string }>) =>
  cases.filter((c) => c.caseKey.includes("qread-test-"));

const refsOf = (cases: Array<{ caseKey: string }>) =>
  ours(cases).map((c) => c.caseKey.split(":")[1]);

describe("RegulationQueueReadRepository.listQueue", () => {
  test("urgency outranks recency; within a band newest queued first; snoozed hidden", async () => {
    if (!runCtx) return;
    const repo = new RegulationQueueReadRepository(runCtx.db);
    const { cases } = await repo.listQueue({ limit: 200, offset: 0 });
    expect(refsOf(cases)).toEqual([
      // Critical stays on top even though it is read and 100h old (§12).
      "qread-test-critical-read",
      "qread-test-newest",
      "qread-test-snooze-expired",
      "qread-test-older",
      // qread-test-snoozed hidden until its snooze passes.
    ]);
  });

  test("includeSnoozed surfaces the snoozed case in its recency slot", async () => {
    if (!runCtx) return;
    const repo = new RegulationQueueReadRepository(runCtx.db);
    const { cases } = await repo.listQueue({
      includeSnoozed: true,
      limit: 200,
      offset: 0,
    });
    expect(refsOf(cases)).toContain("qread-test-snoozed");
  });

  test("filters: unread, adminStatus, jurisdiction, assignee", async () => {
    if (!runCtx) return;
    const repo = new RegulationQueueReadRepository(runCtx.db);
    const unread = await repo.listQueue({
      unread: true,
      limit: 200,
      offset: 0,
    });
    expect(refsOf(unread.cases)).not.toContain("qread-test-critical-read");
    expect(refsOf(unread.cases)).toContain("qread-test-newest");

    const byStatus = await repo.listQueue({
      adminStatus: ["under_review"],
      limit: 200,
      offset: 0,
    });
    expect(refsOf(byStatus.cases)).toEqual(["qread-test-critical-read"]);

    const byJurisdiction = await repo.listQueue({
      jurisdiction: ["NO", "IS"],
      limit: 200,
      offset: 0,
    });
    expect(refsOf(byJurisdiction.cases).sort()).toEqual([
      "qread-test-newest",
      "qread-test-older",
    ]);

    const byAssignee = await repo.listQueue({
      assignee: "gilli",
      limit: 200,
      offset: 0,
    });
    expect(refsOf(byAssignee.cases)).toEqual(["qread-test-critical-read"]);
  });

  test("total counts the whole filtered set, not the page", async () => {
    if (!runCtx) return;
    const repo = new RegulationQueueReadRepository(runCtx.db);
    // The shared test DB holds other suites' cases, so assert the property
    // rather than an absolute number: total matches the unpaginated row
    // count while the page holds only one row.
    const all = await repo.listQueue({
      jurisdiction: ["NO", "IS"],
      limit: 200,
      offset: 0,
    });
    const page = await repo.listQueue({
      jurisdiction: ["NO", "IS"],
      limit: 1,
      offset: 0,
    });
    expect(page.cases).toHaveLength(1);
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(page.total).toBe(all.total);
    expect(page.total).toBe(all.cases.length);
  });
});

describe("RegulationQueueReadRepository.counts", () => {
  test("unread excludes snoozed; snoozed counted separately", async () => {
    if (!runCtx) return;
    const repo = new RegulationQueueReadRepository(runCtx.db);
    // The shared DB may hold other suites' cases, so assert deltas are
    // impossible — instead seed-derived invariants: our 3 non-snoozed unread
    // cases and 1 snoozed one are lower bounds, and the snoozed case must
    // not be inside the unread number.
    const counts = await repo.counts();
    expect(counts.snoozed).toBeGreaterThanOrEqual(1);
    expect(counts.unread).toBeGreaterThanOrEqual(3);
    const { total: allUnreadInclSnoozed } = await repo.listQueue({
      unread: true,
      includeSnoozed: true,
      limit: 1,
      offset: 0,
    });
    const { total: unreadVisible } = await repo.listQueue({
      unread: true,
      limit: 1,
      offset: 0,
    });
    expect(counts.unread).toBe(unreadVisible);
    expect(allUnreadInclSnoozed).toBeGreaterThan(unreadVisible);
    expect(counts.byAdminStatus.under_review).toBeGreaterThanOrEqual(1);
  });
});

describe("RegulationQueueReadRepository.getCaseDetail", () => {
  test("assembles revisions with their own geometries; isCurrent follows the pointer, not max(position)", async () => {
    if (!runCtx) return;
    const { db } = runCtx;
    const seeded = await seedCase(db, {
      ref: "qread-test-detail",
      queuedHoursAgo: 3,
    });
    // A second revision that is NOT current — the pointer stays on rev 0,
    // the rollback-addressability the schema promises.
    const rev1Id = revisionIdFor("qread-test-detail-rev-1");
    await db.insert(schema.regulationCaseRevisions).values({
      id: rev1Id,
      caseId: seeded.caseId,
      position: 1,
      changeType: "amendment",
      author: "collector:test",
      snapshotUrl: "https://example.test/qread-test-detail",
      sourceEventSignature: "qread-test-detail-rev-1",
    });
    await db.insert(schema.regulationCaseGeometries).values([
      {
        id: geometryIdFor(seeded.revisionId, 0),
        caseId: seeded.caseId,
        revisionId: seeded.revisionId,
        position: 0,
        name: "Area A",
        points: [{ lat: 62.0, lon: -6.8 }],
      },
      {
        id: geometryIdFor(rev1Id, 0),
        caseId: seeded.caseId,
        revisionId: rev1Id,
        position: 0,
        name: "Area A amended",
        points: [{ lat: 62.1, lon: -6.9 }],
      },
    ]);
    await db.insert(schema.regulationCaseSources).values({
      caseId: seeded.caseId,
      sourceType: "test-source",
      sourceRef: "qread-test-detail",
      isPrimary: true,
      firstSeenAt: new Date(NOW - 3 * HOUR),
      lastCheckedAt: new Date(NOW),
    });
    await db.insert(schema.regulationCaseLinks).values({
      caseId: seeded.caseId,
      kind: "replaces",
      targetCaseKey: "test-source:qread-test-predecessor",
    });

    const repo = new RegulationQueueReadRepository(db);
    const detail = await repo.getCaseDetail(seeded.caseId);
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.case.id).toBe(seeded.caseId);
    expect(detail.revisions).toHaveLength(2);
    const [rev0, rev1] = detail.revisions;
    expect(rev0?.isCurrent).toBe(true);
    expect(rev1?.isCurrent).toBe(false);
    expect(rev0?.geometries.map((g) => g.name)).toEqual(["Area A"]);
    expect(rev1?.geometries.map((g) => g.name)).toEqual(["Area A amended"]);
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]?.isPrimary).toBe(true);
    expect(detail.links[0]?.targetCaseKey).toBe(
      "test-source:qread-test-predecessor",
    );
  });

  test("unknown case id is null", async () => {
    if (!runCtx) return;
    const repo = new RegulationQueueReadRepository(runCtx.db);
    expect(
      await repo.getCaseDetail("00000000-0000-8000-8000-000000000000"),
    ).toBeNull();
  });
});
