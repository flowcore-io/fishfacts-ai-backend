import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type { RegulationAdminAction } from "../../src/events/contracts";
import { RegulationCaseActionProjector } from "../../src/regulations/action-projector";
import { caseIdFor, revisionIdFor } from "../../src/regulations/ids";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_actions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'action-test-%')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'action-test-%')`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE 'action-test-%'`;
}

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await cleanup(client);
  return { db, client };
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[action-projector.test] skipping — could not connect to test PostGIS DB",
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

async function seedCase(ref: string) {
  if (!runCtx) throw new Error("no db");
  const { db } = runCtx;
  const caseKey = `test-source:${ref}`;
  const caseId = caseIdFor(caseKey);
  const revisionId = revisionIdFor(`${ref}-rev-0`);
  const now = new Date();
  await db.insert(schema.regulationCases).values({
    id: caseId,
    caseKey,
    sourceType: "test-source",
    sourceRef: ref,
    jurisdiction: "FO",
    title: `Action test ${ref}`,
    sourceUrl: `https://example.test/${ref}`,
    detectedBy: "test",
    firstSeenAt: now,
    lastCheckedAt: now,
    currentRevisionId: revisionId,
  });
  await db.insert(schema.regulationCaseRevisions).values({
    id: revisionId,
    caseId,
    position: 0,
    changeType: "new",
    author: "collector:test",
    snapshotUrl: `https://example.test/${ref}`,
    sourceEventSignature: `${ref}-rev-0`,
  });
  return { caseId, caseKey };
}

function recordOf(
  caseId: string,
  caseKey: string,
  action: RegulationAdminAction,
  actionId = randomUUID(),
) {
  return {
    actionId,
    caseId,
    caseKey,
    action,
    actor: "admin:gilli",
    recordedAt: new Date().toISOString(),
  };
}

async function caseRow(caseId: string) {
  if (!runCtx) throw new Error("no db");
  const [row] = await runCtx.db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, caseId));
  return row;
}

async function actionRows(caseId: string) {
  if (!runCtx) throw new Error("no db");
  return await runCtx.db
    .select()
    .from(schema.regulationCaseActions)
    .where(eq(schema.regulationCaseActions.caseId, caseId));
}

describe("RegulationCaseActionProjector", () => {
  test("mark_read flips is_read, moves unread → under_review, and logs; un-read keeps the status", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseActionProjector(runCtx.db);
    const { caseId, caseKey } = await seedCase("action-test-read");

    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "mark_read", read: true }),
    );
    let row = await caseRow(caseId);
    expect(row?.isRead).toBe(true);
    expect(row?.adminStatus).toBe("under_review");

    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "mark_read", read: false }),
    );
    row = await caseRow(caseId);
    expect(row?.isRead).toBe(false);
    // The case HAS been reviewed once; un-reading is prominence, not status.
    expect(row?.adminStatus).toBe("under_review");

    const log = await actionRows(caseId);
    expect(log).toHaveLength(2);
    expect(log.every((entry) => entry.actor === "admin:gilli")).toBe(true);
  });

  test("assign / set_urgency / snooze write and clear their columns", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseActionProjector(runCtx.db);
    const { caseId, caseKey } = await seedCase("action-test-columns");
    const until = new Date(Date.now() + 3600_000);

    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "assign", assignee: "gilli" }),
    );
    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "set_urgency", urgency: "critical" }),
    );
    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "snooze", until: until.toISOString() }),
    );
    let row = await caseRow(caseId);
    expect(row?.assignee).toBe("gilli");
    expect(row?.urgency).toBe("critical");
    expect(row?.snoozeUntil?.getTime()).toBe(until.getTime());

    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "assign", assignee: null }),
    );
    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "snooze", until: null }),
    );
    row = await caseRow(caseId);
    expect(row?.assignee).toBeNull();
    expect(row?.snoozeUntil).toBeNull();
  });

  test("request_information / reject / mark_duplicate change lane", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseActionProjector(runCtx.db);
    const { caseId, caseKey } = await seedCase("action-test-lanes");
    const other = await seedCase("action-test-lanes-dup-target");

    await projector.handleRecorded(
      recordOf(caseId, caseKey, {
        kind: "request_information",
        note: "Which vessels does §2 cover?",
      }),
    );
    expect((await caseRow(caseId))?.adminStatus).toBe("awaiting_information");

    await projector.handleRecorded(
      recordOf(caseId, caseKey, {
        kind: "mark_duplicate",
        duplicateOfCaseId: other.caseId,
      }),
    );
    let row = await caseRow(caseId);
    expect(row?.adminStatus).toBe("duplicate");
    expect(row?.duplicateOfCaseId).toBe(other.caseId);

    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "reject", reason: "Not a regulation" }),
    );
    row = await caseRow(caseId);
    expect(row?.adminStatus).toBe("rejected");

    // The ask and the reason survive on the log rows.
    const log = await actionRows(caseId);
    const note = log.find((entry) => entry.kind === "request_information");
    expect((note?.action as { note?: string }).note).toContain("§2");
  });

  test("a redelivered event neither doubles the log nor clobbers later state", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseActionProjector(runCtx.db);
    const { caseId, caseKey } = await seedCase("action-test-replay");

    const first = recordOf(caseId, caseKey, {
      kind: "assign",
      assignee: "gilli",
    });
    await projector.handleRecorded(first);
    await projector.handleRecorded(
      recordOf(caseId, caseKey, { kind: "assign", assignee: "anna" }),
    );
    // Redelivery of the FIRST event, after a later one moved the column.
    await projector.handleRecorded(first);

    expect((await caseRow(caseId))?.assignee).toBe("anna");
    expect(await actionRows(caseId)).toHaveLength(2);
  });

  test("an action for an unknown case commits NOTHING — no orphan log row, no throw", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseActionProjector(runCtx.db);
    const ghostId = caseIdFor("test-source:action-test-ghost");
    await projector.handleRecorded(
      recordOf(ghostId, "ghost", { kind: "mark_read", read: true }),
    );
    // A log row without its case effect would be exactly the trail/state
    // disagreement the projector exists to prevent.
    expect(await actionRows(ghostId)).toHaveLength(0);
  });
});
