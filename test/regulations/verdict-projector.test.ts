import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type { JMeldingAnnouncementDiscovered } from "../../src/events/contracts";
import { RegulationCaseProjector } from "../../src/regulations/case-projector";
import { RegulationVerdictProjector } from "../../src/regulations/verdict-projector";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_geometries WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE '%vtest-%')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE '%vtest-%')`;
  await client`DELETE FROM regulation_case_sources WHERE source_ref LIKE '%vtest-%'`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE '%vtest-%'`;
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
      "[verdict-projector.test] skipping — could not connect to test PostGIS DB",
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

function makeItem(
  jmNumber: string,
  overrides: Partial<JMeldingAnnouncementDiscovered> = {},
): JMeldingAnnouncementDiscovered {
  return {
    signature: `sig-${jmNumber}`,
    title: `Test ${jmNumber}`,
    url: `https://www.fiskeridir.no/yrkesfiske/j-meldinger/${jmNumber}`,
    status: "current",
    region: "NO",
    jmNumber,
    bodyMarkdown: "Det er forbudt å fiske i testområdet.",
    contentHash: `hash-${jmNumber}`,
    checkedAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

const ISSUE = {
  field: "§ 1",
  kind: "missing_expiry" as const,
  ref: null,
  confidence: 0.8,
};

describe("RegulationVerdictProjector", () => {
  test("lands an ok verdict on the revision and mirrors it onto the case", async () => {
    if (!runCtx) return;
    const cases = new RegulationCaseProjector(runCtx.db);
    const verdicts = new RegulationVerdictProjector(runCtx.db);
    const created = await cases.project(makeItem("vtest-J-1-2026"));

    await verdicts.handleRecorded({
      verdictId: "00000000-0000-4000-8000-000000000001",
      caseKey: created.caseKey,
      revisionId: created.revisionId,
      contentHash: "hash-vtest-J-1-2026",
      status: "ok",
      issues: [ISSUE, { ...ISSUE, field: "§ 2", confidence: 0.5 }],
      error: null,
      model: "google/gemini-3.7-flash",
      recordedAt: "2026-09-03T12:00:00.000Z",
    });

    const [revision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, created.revisionId));
    expect(revision?.verdictStatus).toBe("ok");
    expect((revision?.verdict as Array<unknown>).length).toBe(2);
    // Record-level confidence is the shakiest claim's.
    expect(revision?.verdictConfidence).toBe(0.5);
    expect(revision?.verdictModel).toBe("google/gemini-3.7-flash");

    const [row] = await runCtx.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, created.caseId));
    expect(row?.verdictStatus).toBe("ok");
  });

  test("a stale verdict never overwrites a newer revision's pending", async () => {
    if (!runCtx) return;
    const cases = new RegulationCaseProjector(runCtx.db);
    const verdicts = new RegulationVerdictProjector(runCtx.db);
    const created = await cases.project(makeItem("vtest-J-2-2026"));
    const revised = await cases.project(
      makeItem("vtest-J-2-2026", {
        signature: "sig-vtest-J-2-2026-v2",
        contentHash: "hash-vtest-J-2-2026-v2",
      }),
    );
    expect(revised.outcome).toBe("revised");

    // The verdict for the FIRST revision arrives after the text moved on.
    await verdicts.handleRecorded({
      verdictId: "00000000-0000-4000-8000-000000000002",
      caseKey: created.caseKey,
      revisionId: created.revisionId,
      contentHash: "hash-vtest-J-2-2026",
      status: "ok",
      issues: [ISSUE],
      error: null,
      model: null,
      recordedAt: "2026-09-03T12:00:00.000Z",
    });

    const [oldRevision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, created.revisionId));
    expect(oldRevision?.verdictStatus).toBe("ok");

    const [row] = await runCtx.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, created.caseId));
    expect(row?.verdictStatus).toBe("pending");
  });

  test("a failed verdict is a recorded case state", async () => {
    if (!runCtx) return;
    const cases = new RegulationCaseProjector(runCtx.db);
    const verdicts = new RegulationVerdictProjector(runCtx.db);
    const created = await cases.project(makeItem("vtest-J-3-2026"));

    await verdicts.handleRecorded({
      verdictId: "00000000-0000-4000-8000-000000000003",
      caseKey: created.caseKey,
      revisionId: created.revisionId,
      contentHash: null,
      status: "failed",
      issues: [],
      error: "answer is not JSON",
      model: null,
      recordedAt: "2026-09-03T12:00:00.000Z",
    });

    const [revision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, created.revisionId));
    expect(revision?.verdictStatus).toBe("failed");
    expect(revision?.verdict).toBeNull();
    expect(revision?.parseError).toBe("answer is not JSON");

    const [row] = await runCtx.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, created.caseId));
    expect(row?.verdictStatus).toBe("failed");
  });
});
