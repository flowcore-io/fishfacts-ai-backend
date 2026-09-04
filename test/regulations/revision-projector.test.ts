import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type { RegulationRevisionFields } from "../../src/events/contracts";
import {
  caseIdFor,
  geometryIdFor,
  revisionIdFor,
} from "../../src/regulations/ids";
import { RegulationRevisionProjector } from "../../src/regulations/revision-projector";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_approvals WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'revproj-test-%')`;
  await client`DELETE FROM regulation_case_validations WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'revproj-test-%')`;
  await client`DELETE FROM regulation_case_actions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'revproj-test-%')`;
  await client`DELETE FROM regulation_case_geometries WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'revproj-test-%')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'revproj-test-%')`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE 'revproj-test-%'`;
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
      "[revision-projector.test] skipping — could not connect to test PostGIS DB",
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

const BASE_FIELDS: RegulationRevisionFields = {
  title: "Original title",
  authority: null,
  regulationNumber: null,
  category: null,
  summary: null,
  effectiveFrom: null,
  effectiveTo: null,
  expiresAt: null,
  seasonalRecurrence: null,
  interpretationNotes: null,
  applicability: null,
};

async function seedCase(ref: string, opts: { geometries?: number } = {}) {
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
    title: "Original title",
    sourceUrl: `https://example.test/${ref}`,
    detectedBy: "test",
    adminStatus: "under_review",
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
    snapshotText: "Original statute text",
    snapshotUrl: `https://example.test/${ref}`,
    sourceEventSignature: `${ref}-rev-0`,
    verdictStatus: "ok",
    verdict: [],
    fields: { ...BASE_FIELDS },
  });
  const geometryIds: string[] = [];
  for (let i = 0; i < (opts.geometries ?? 0); i += 1) {
    const gid = geometryIdFor(revisionId, i);
    geometryIds.push(gid);
    await db.insert(schema.regulationCaseGeometries).values({
      id: gid,
      caseId,
      revisionId,
      position: i,
      name: `Area ${i}`,
      points: [{ lat: 62 + i, lon: -6.8 }],
      geometrySource: "enumerated",
    });
  }
  return { caseId, caseKey, revisionId, geometryIds };
}

function proposal(
  seeded: { caseId: string; caseKey: string; revisionId: string },
  overrides: Partial<{
    revisionId: string;
    baseRevisionId: string;
    fields: RegulationRevisionFields;
    geometries: Array<{
      name: string | null;
      section: string | null;
      kind: "closure" | "exemption" | "other";
      season: string | null;
      verticesQuoted: string[] | null;
      points: Array<{ lat: number; lon: number }>;
      geometrySource: "enumerated" | "preparsed" | "described";
      coordinateSystem: string;
      precision: string | null;
    }>;
  }> = {},
) {
  return {
    revisionId: overrides.revisionId ?? randomUUID(),
    caseId: seeded.caseId,
    caseKey: seeded.caseKey,
    baseRevisionId: overrides.baseRevisionId ?? seeded.revisionId,
    changes: [
      { field: "title" as const, justification: "clarified per Gilli" },
    ],
    fields: overrides.fields ?? { ...BASE_FIELDS, title: "Amended title" },
    geometries: overrides.geometries ?? [],
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

describe("RegulationRevisionProjector.handleProposed", () => {
  test("lands the draft: new revision + areas, pointer moved, fields applied, validations reset", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-propose");
    await runCtx.db
      .update(schema.regulationCases)
      .set({ regulatoryValidated: true })
      .where(eq(schema.regulationCases.id, seeded.caseId));

    const event = proposal(seeded, {
      geometries: [
        {
          name: "Corrected area",
          section: "§2",
          kind: "closure",
          season: null,
          verticesQuoted: null,
          points: [{ lat: 62.01, lon: -6.77 }],
          geometrySource: "enumerated",
          coordinateSystem: "WGS84",
          precision: null,
        },
      ],
    });
    await projector.handleProposed(event);

    const row = await caseRow(seeded.caseId);
    expect(row?.currentRevisionId).toBe(event.revisionId);
    expect(row?.title).toBe("Amended title");
    // A new draft is a different revision — earlier validations do not carry.
    expect(row?.regulatoryValidated).toBe(false);
    expect(row?.geometryValidated).toBe(false);

    const [revision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, event.revisionId));
    expect(revision?.position).toBe(1);
    expect(revision?.baseRevisionId).toBe(seeded.revisionId);
    expect(revision?.author).toBe("admin:gilli");
    // The snapshot and verdict carry over verbatim — same source text.
    expect(revision?.snapshotText).toBe("Original statute text");
    expect(revision?.verdictStatus).toBe("ok");

    const geometries = await runCtx.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, event.revisionId));
    expect(geometries).toHaveLength(1);
    expect(geometries[0]?.id).toBe(geometryIdFor(event.revisionId, 0));
    expect(geometries[0]?.geometryValidated).toBe(false);
  });

  test("a draft against a superseded base is not landed", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-stale-base");
    const winner = proposal(seeded);
    await projector.handleProposed(winner);
    const loser = proposal(seeded, {
      fields: { ...BASE_FIELDS, title: "Racing title" },
    });
    await projector.handleProposed(loser);

    const row = await caseRow(seeded.caseId);
    expect(row?.currentRevisionId).toBe(winner.revisionId);
    expect(row?.title).toBe("Amended title");
    const [loserRow] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, loser.revisionId));
    expect(loserRow).toBeUndefined();
  });

  test("redelivery is a no-op", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-replay");
    const event = proposal(seeded);
    await projector.handleProposed(event);
    await projector.handleProposed(event);
    const revisions = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.caseId, seeded.caseId));
    expect(revisions).toHaveLength(2);
  });
});

describe("RegulationRevisionProjector.handlePointerMoved", () => {
  test("undo restores the fields, verdict and validation flags of the target revision", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-undo", { geometries: 1 });

    // Validate the collector revision fully, then draft over it.
    await projector.handleValidationRecorded({
      validationId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId,
      scope: "legal",
      geometryId: null,
      validated: true,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    const draft = proposal(seeded);
    await projector.handleProposed(draft);
    let row = await caseRow(seeded.caseId);
    expect(row?.title).toBe("Amended title");
    expect(row?.regulatoryValidated).toBe(false);

    await projector.handlePointerMoved({
      pointerMoveId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      toRevisionId: seeded.revisionId,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    row = await caseRow(seeded.caseId);
    expect(row?.currentRevisionId).toBe(seeded.revisionId);
    expect(row?.title).toBe("Original title");
    // The old revision's legal validation stands again — it named THIS
    // revision, and the pointer came back to it.
    expect(row?.regulatoryValidated).toBe(true);
  });
});

describe("RegulationRevisionProjector.handleValidationRecorded", () => {
  test("legal and per-geometry validation land separately and steer the lane", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-validate", { geometries: 2 });

    const validate = (
      scope: "legal" | "geometry",
      geometryId: string | null,
      validated = true,
    ) =>
      projector.handleValidationRecorded({
        validationId: randomUUID(),
        caseId: seeded.caseId,
        caseKey: seeded.caseKey,
        revisionId: seeded.revisionId,
        scope,
        geometryId,
        validated,
        note: null,
        actor: "admin:gilli",
        recordedAt: new Date().toISOString(),
      });

    await validate("legal", null);
    let row = await caseRow(seeded.caseId);
    expect(row?.regulatoryValidated).toBe(true);
    expect(row?.geometryValidated).toBe(false);
    expect(row?.adminStatus).toBe("awaiting_geometry_validation");

    await validate("geometry", seeded.geometryIds[0] as string);
    row = await caseRow(seeded.caseId);
    // One of two areas — the case flag holds out for ALL of them.
    expect(row?.geometryValidated).toBe(false);

    await validate("geometry", seeded.geometryIds[1] as string);
    row = await caseRow(seeded.caseId);
    expect(row?.geometryValidated).toBe(true);

    // Withdrawing the legal validation flips the flag back.
    await validate("legal", null, false);
    row = await caseRow(seeded.caseId);
    expect(row?.regulatoryValidated).toBe(false);
    expect(row?.adminStatus).toBe("awaiting_regulatory_validation");
  });

  test("a validation of a superseded revision is history, not state", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-validate-stale");
    const draft = proposal(seeded);
    await projector.handleProposed(draft);

    await projector.handleValidationRecorded({
      validationId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId, // the superseded one
      scope: "legal",
      geometryId: null,
      validated: true,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    const row = await caseRow(seeded.caseId);
    expect(row?.regulatoryValidated).toBe(false);
    const rows = await runCtx.db
      .select()
      .from(schema.regulationCaseValidations)
      .where(eq(schema.regulationCaseValidations.caseId, seeded.caseId));
    expect(rows).toHaveLength(1); // recorded all the same
  });
});

describe("RegulationRevisionProjector.handleApprovalRecorded", () => {
  test("the full §12 walk: validate legally → validate each area → approve", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-walk", { geometries: 1 });
    const validate = (scope: "legal" | "geometry", geometryId: string | null) =>
      projector.handleValidationRecorded({
        validationId: randomUUID(),
        caseId: seeded.caseId,
        caseKey: seeded.caseKey,
        revisionId: seeded.revisionId,
        scope,
        geometryId,
        validated: true,
        note: null,
        actor: "admin:gilli",
        recordedAt: new Date().toISOString(),
      });
    await validate("legal", null);
    await validate("geometry", seeded.geometryIds[0] as string);

    await projector.handleApprovalRecorded({
      approvalId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId,
      metadataOnly: false,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    const row = await caseRow(seeded.caseId);
    expect(row?.adminStatus).toBe("approved");
    expect(row?.regulationStatus).toBe("validated");
    const [approval] = await runCtx.db
      .select()
      .from(schema.regulationCaseApprovals)
      .where(eq(schema.regulationCaseApprovals.caseId, seeded.caseId));
    expect(approval?.applied).toBe(true);
    expect(approval?.refusalReason).toBeNull();
  });

  test("an approval of a superseded revision is recorded refused, never applied", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-approve-stale");
    const draft = proposal(seeded);
    await projector.handleProposed(draft);

    await projector.handleApprovalRecorded({
      approvalId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId, // superseded between route check and projection
      metadataOnly: true,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    const row = await caseRow(seeded.caseId);
    expect(row?.adminStatus).not.toBe("approved");
    const [approval] = await runCtx.db
      .select()
      .from(schema.regulationCaseApprovals)
      .where(eq(schema.regulationCaseApprovals.caseId, seeded.caseId));
    expect(approval?.applied).toBe(false);
    expect(approval?.refusalReason).toContain("stale revision");
  });

  test("a zero-geometry case never dead-ends: lane stays put, approval needs the explicit metadataOnly", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-zero-geom");

    await projector.handleValidationRecorded({
      validationId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId,
      scope: "legal",
      geometryId: null,
      validated: true,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    let row = await caseRow(seeded.caseId);
    expect(row?.regulatoryValidated).toBe(true);
    // No areas exist — steering to awaiting_geometry_validation would be a
    // dead-end lane with nothing in it to validate.
    expect(row?.adminStatus).toBe("under_review");
    // And zero areas is NOT vacuous validation: a text-only statute and a
    // parse that dropped its areas look identical at zero rows.
    expect(row?.geometryValidated).toBe(false);

    await projector.handleApprovalRecorded({
      approvalId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId,
      metadataOnly: false,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    row = await caseRow(seeded.caseId);
    expect(row?.adminStatus).not.toBe("approved");
    const [refused] = await runCtx.db
      .select()
      .from(schema.regulationCaseApprovals)
      .where(eq(schema.regulationCaseApprovals.caseId, seeded.caseId));
    expect(refused?.applied).toBe(false);
    expect(refused?.refusalReason).toContain("geometry");
  });

  test("editing or undoing an approved case un-approves it; a no-op pointer move does not", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-unapprove", { geometries: 1 });
    const approve = async (revisionId: string) => {
      await projector.handleValidationRecorded({
        validationId: randomUUID(),
        caseId: seeded.caseId,
        caseKey: seeded.caseKey,
        revisionId,
        scope: "legal",
        geometryId: null,
        validated: true,
        note: null,
        actor: "admin:gilli",
        recordedAt: new Date().toISOString(),
      });
      await projector.handleApprovalRecorded({
        approvalId: randomUUID(),
        caseId: seeded.caseId,
        caseKey: seeded.caseKey,
        revisionId,
        metadataOnly: true,
        note: null,
        actor: "admin:gilli",
        recordedAt: new Date().toISOString(),
      });
    };
    await approve(seeded.revisionId);
    expect((await caseRow(seeded.caseId))?.adminStatus).toBe("approved");

    // A no-op pointer move to the already-current revision changes nothing.
    await projector.handlePointerMoved({
      pointerMoveId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      toRevisionId: seeded.revisionId,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    expect((await caseRow(seeded.caseId))?.adminStatus).toBe("approved");

    // A new draft moves the pointer off the approved revision → demoted.
    const draft = proposal(seeded);
    await projector.handleProposed(draft);
    let row = await caseRow(seeded.caseId);
    expect(row?.adminStatus).toBe("under_review");
    expect(row?.regulationStatus).toBe("draft");

    // Re-approve the draft, then undo away from it → demoted again.
    await approve(draft.revisionId);
    expect((await caseRow(seeded.caseId))?.adminStatus).toBe("approved");
    await projector.handlePointerMoved({
      pointerMoveId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      toRevisionId: seeded.revisionId,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    row = await caseRow(seeded.caseId);
    expect(row?.adminStatus).toBe("under_review");
    expect(row?.regulationStatus).toBe("draft");
    expect(row?.currentRevisionId).toBe(seeded.revisionId);
  });

  test("metadataOnly approval passes on legal validation alone", async () => {
    if (!runCtx) return;
    const projector = new RegulationRevisionProjector(runCtx.db);
    const seeded = await seedCase("revproj-test-metadata-only");
    await projector.handleValidationRecorded({
      validationId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId,
      scope: "legal",
      geometryId: null,
      validated: true,
      note: null,
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    await projector.handleApprovalRecorded({
      approvalId: randomUUID(),
      caseId: seeded.caseId,
      caseKey: seeded.caseKey,
      revisionId: seeded.revisionId,
      metadataOnly: true,
      note: "no drawable geometry in the source",
      actor: "admin:gilli",
      recordedAt: new Date().toISOString(),
    });
    const row = await caseRow(seeded.caseId);
    expect(row?.adminStatus).toBe("approved");
  });
});
