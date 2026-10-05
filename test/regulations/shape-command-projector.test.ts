import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type { CaseCommand } from "../../src/events/regulation-case-command";
import { verifyApprovalEvidence } from "../../src/regulations/approval-evidence";
import {
  type RevisionShapeState,
  coverageDigest,
  manifestDigest,
  shapeDigest,
  verifyShapeState,
} from "../../src/regulations/coastal-state";
import { caseIdFor, geometryIdFor } from "../../src/regulations/ids";
import {
  GeometryClientUpgradeError,
  RegulationPublishedReadRepository,
} from "../../src/regulations/published-repository";
import { RegulationShapeCommandProjector } from "../../src/regulations/shape-command-projector";
import fixture from "./fixtures/complete-shape.json";

const { db, client } = createDb(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
);
const projector = new RegulationShapeCommandProjector();
const cases: string[] = [];
const fields = {
  title: "Complete synthetic source",
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
const state = verifyShapeState(fixture.state, fixture.text, fixture.runs);
beforeAll(async () => {
  await runMigrations(db, client);
});
afterAll(async () => {
  for (const id of cases) {
    for (const table of [
      schema.regulationCaseApprovals,
      schema.regulationCaseValidations,
      schema.regulationCaseGeometries,
      schema.regulationCaseRevisions,
    ]) {
      await db.delete(table).where(eq(table.caseId, id));
    }
    await db
      .delete(schema.regulationCases)
      .where(eq(schema.regulationCases.id, id));
  }
  await client.end();
});
async function seed(immutableState: RevisionShapeState = state) {
  const sourceRef = randomUUID();
  const caseKey = `fiskeridir-jmelding:${sourceRef}`;
  const caseId = caseIdFor(caseKey);
  const revisionId = randomUUID();
  cases.push(caseId);
  const now = new Date();
  const url = "https://example.test/complete-shape";
  await db.insert(schema.regulationCases).values({
    id: caseId,
    caseKey,
    sourceType: "fiskeridir-jmelding",
    sourceRef,
    jurisdiction: "NO",
    title: fields.title,
    sourceUrl: url,
    detectedBy: "test",
    firstSeenAt: now,
    lastCheckedAt: now,
    currentRevisionId: revisionId,
    geometryModelVersion: 1,
  });
  await db.insert(schema.regulationCaseRevisions).values({
    id: revisionId,
    caseId,
    position: 0,
    changeType: "new",
    author: "admin:test",
    snapshotText: fixture.text,
    snapshotUrl: url,
    sourceEventSignature: caseId,
    fields,
    geometryModelVersion: 1,
    shapeState: immutableState,
  });
  for (const run of fixture.runs) {
    await db.insert(schema.regulationCaseGeometries).values({
      ...run,
      id: geometryIdFor(revisionId, run.position),
      caseId,
      revisionId,
    });
  }
  let sequence = 0;
  const command = (
    operation: CaseCommand["operation"],
    data: unknown,
    target = revisionId,
  ): CaseCommand => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    caseId,
    baseRevisionId: revisionId,
    revisionId: target,
    sequence: ++sequence,
    predecessorCommandId: null,
    operation,
    actor: "admin:test",
    recordedAt: new Date().toISOString(),
    data,
  });
  const proposal = () =>
    command(
      "proposal",
      {
        fields: { ...fields, title: "Edited metadata" },
        geometries: fixture.runs,
        shapeState: immutableState,
        changes: [
          { field: "title", justification: "Synthetic metadata change" },
        ],
        snapshot: {
          text: fixture.text,
          url,
          fetchedAt: null,
          fragmentId: null,
        },
      },
      randomUUID(),
    );
  const approval = (manifest = immutableState.shapeManifestHash) =>
    command("approval", {
      approvalId: randomUUID(),
      shapeManifestHash: manifest,
      metadataOnly: false,
      note: null,
    });
  return {
    caseId,
    revisionId,
    command,
    proposal,
    approval,
    state: immutableState,
    sourceRef,
  };
}
const apply = (c: CaseCommand) =>
  db.transaction((tx) => projector.apply(tx, c));
async function validate(s: Awaited<ReturnType<typeof seed>>) {
  for (const data of [
    { scope: "legal", validationId: randomUUID(), validated: true, note: null },
    {
      scope: "coverage",
      validationId: randomUUID(),
      validated: true,
      note: null,
      coverageHash: s.state.coverage.coverageHash,
    },
    {
      scope: "shape",
      validationId: randomUUID(),
      validated: true,
      note: null,
      shapeId: s.state.shapes[0].id,
      shapeHash: s.state.shapes[0].shapeHash,
    },
  ])
    expect(
      (
        await apply(
          s.command(
            data.scope === "coverage" ? "coverage-validation" : "validation",
            data,
          ),
        )
      ).status,
    ).toBe("applied");
}
/** Both transactions exist before either domain handler starts. These invoke
 * the real case row lock/CAS, not a utility effect callback or mocked mutex. */
async function concurrent(commands: CaseCommand[]) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Promise.all(
    commands.map((c) =>
      db.transaction(async (tx) => {
        if (++arrived === commands.length) release();
        await ready;
        return projector.apply(tx, c);
      }),
    ),
  );
}
test("concurrent same-base proposals create only one draft", async () => {
  const s = await seed();
  const proposals = [s.proposal(), s.proposal()];
  const results = await concurrent(proposals);
  expect(results.map((r) => r.status).sort()).toEqual(["applied", "refused"]);
  const revisions = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.caseId, s.caseId));
  expect(revisions).toHaveLength(2);
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, s.caseId));
  expect(row.currentRevisionId).toBe(
    proposals[results.findIndex((r) => r.status === "applied")].revisionId,
  );
}, 5000);
test("concurrent approval and redraft cannot publish the other revision or move an approved pin", async () => {
  const s = await seed();
  await validate(s);
  const proposal = s.proposal();
  const [approvalResult, proposalResult] = await concurrent([
    s.approval(),
    proposal,
  ]);
  expect(proposalResult.status).toBe("applied");
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, s.caseId));
  expect(row.currentRevisionId).toBe(proposal.revisionId);
  expect(row.publishedRevisionId).toBe(
    approvalResult.status === "applied" ? s.revisionId : null,
  );
  const approvals = await db
    .select()
    .from(schema.regulationCaseApprovals)
    .where(eq(schema.regulationCaseApprovals.caseId, s.caseId));
  expect(approvals).toHaveLength(1);
  expect(approvals[0].applied).toBe(approvalResult.status === "applied");
}, 5000);
test("exact approved geometry and evidence remain unchanged after negative validation and metadata redraft", async () => {
  const s = await seed();
  await validate(s);
  expect((await apply(s.approval())).status).toBe("applied");
  const [approval] = await db
    .select()
    .from(schema.regulationCaseApprovals)
    .where(eq(schema.regulationCaseApprovals.caseId, s.caseId));
  expect(
    verifyApprovalEvidence(approval.approvalEvidence, state, false).kind,
  ).toBe("drawable");
  expect(
    (
      await apply(
        s.command("validation", {
          scope: "shape",
          validationId: randomUUID(),
          validated: false,
          note: "Later review",
          shapeId: state.shapes[0].id,
          shapeHash: state.shapes[0].shapeHash,
        }),
      )
    ).status,
  ).toBe("applied");
  expect((await apply(s.proposal())).status).toBe("applied");
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, s.caseId));
  const [pin] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(
      eq(schema.regulationCaseRevisions.id, row.publishedRevisionId ?? ""),
    );
  expect(row.publishedRevisionId).toBe(s.revisionId);
  expect(pin.shapeState).toEqual(state);
  expect(
    verifyApprovalEvidence(
      approval.approvalEvidence,
      verifyShapeState(pin.shapeState, pin.snapshotText, fixture.runs),
      false,
    ).kind,
  ).toBe("drawable");
}, 5000);
test("wrong approval hash is refused and malformed proposal cannot switch current revision", async () => {
  const s = await seed();
  await validate(s);
  expect((await apply(s.approval("a".repeat(64)))).status).toBe("refused");
  const p = s.proposal();
  (p.data as { shapeState: typeof state }).shapeState = {
    ...structuredClone(state),
    shapeManifestHash: "b".repeat(64),
  };
  expect((await apply(p)).status).toBe("refused");
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, s.caseId));
  expect(row.currentRevisionId).toBe(s.revisionId);
  expect(row.publishedRevisionId).toBeNull();
}, 5000);

test("optional and extra drawable shapes cannot publish without their own exact positive decisions", async () => {
  const optional = structuredClone(state);
  optional.coverage.clauses[0].required = false;
  optional.coverage.coverageHash = coverageDigest(optional.coverage);
  const extra = {
    ...structuredClone(optional.shapes[0]),
    id: randomUUID(),
    position: 1,
  };
  extra.shapeHash = shapeDigest(extra);
  optional.shapes.push(extra);
  optional.shapeManifestHash = manifestDigest(optional);
  const s = await seed(optional);
  await validate(s);
  expect((await apply(s.approval())).status).toBe("refused");
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, s.caseId));
  expect(row.publishedRevisionId).toBeNull();
  expect(
    (
      await apply(
        s.command("validation", {
          scope: "shape",
          validationId: randomUUID(),
          validated: true,
          note: null,
          shapeId: extra.id,
          shapeHash: extra.shapeHash,
        }),
      )
    ).status,
  ).toBe("applied");
  expect((await apply(s.approval())).status).toBe("applied");
}, 5000);

test("self-consistent digests cannot admit invalid final serialized GeoJSON", async () => {
  const s = await seed();
  const proposal = s.proposal();
  const invalid = structuredClone(state);
  const geometry = invalid.shapes[0].geojson;
  if (!geometry || geometry.type !== "MultiPolygon")
    throw Error("fixture requires multipart");
  geometry.coordinates[0] = [
    [
      [10, 60],
      [11, 61],
      [10, 61],
      [11, 60],
      [10, 60],
    ],
  ];
  invalid.shapes[0].shapeHash = shapeDigest(invalid.shapes[0]);
  invalid.shapeManifestHash = manifestDigest(invalid);
  (proposal.data as { shapeState: RevisionShapeState }).shapeState = invalid;
  const result = await apply(proposal);
  expect(result.status).toBe("refused");
  expect("reason" in result && result.reason).toContain(
    "invalid serialized shape topology",
  );
  const revisions = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.caseId, s.caseId));
  expect(revisions).toHaveLength(1);
}, 5000);

test("public v2 pin preserves full shape/signature; v1 filters before pagination and refuses detail", async () => {
  const s = await seed();
  await validate(s);
  expect((await apply(s.approval())).status).toBe("applied");
  const reader = new RegulationPublishedReadRepository(db);
  const pin = await reader.getPublished(s.caseId, 2);
  expect(pin?.shapes?.[0].geojson).toEqual(state.shapes[0].geojson);
  expect(pin?.sourceSignature?.sourceRunManifestHash).toBe(
    String(state.shapes[0].provenance.parameters.sourceRunManifestHash),
  );
  expect(pin?.geometryModelVersion).toBe(1);
  expect((await reader.getPublishedSource(s.sourceRef, 2))?.id).toBe(s.caseId);
  expect(
    await reader.getPublishedSource(s.sourceRef.toUpperCase(), 2),
  ).toBeNull();
  await expect(reader.getPublished(s.caseId, 1)).rejects.toBeInstanceOf(
    GeometryClientUpgradeError,
  );
  const v1 = await reader.listPublished({
    status: "all",
    limit: 200,
    offset: 0,
    geometryVersion: 1,
  });
  expect(v1.regulations.some((r) => r.id === s.caseId)).toBe(false);
  const v2 = await reader.listPublished({
    status: "all",
    limit: 200,
    offset: 0,
    geometryVersion: 2,
  });
  expect(v2.total).toBe(
    v1.total +
      v2.regulations.filter((r) => r.geometryModelVersion === 1).length,
  );
  await apply(
    s.command("validation", {
      scope: "shape",
      validationId: randomUUID(),
      validated: false,
      note: null,
      shapeId: state.shapes[0].id,
      shapeHash: state.shapes[0].shapeHash,
    }),
  );
  expect((await reader.getPublished(s.caseId, 2))?.shapes).toEqual(pin?.shapes);
}, 5000);

test("metadata-only publication has no drawable output and missing exact pin receipts fail closed", async () => {
  const s = await seed();
  await apply(
    s.command("validation", {
      scope: "legal",
      validationId: randomUUID(),
      validated: true,
      note: null,
    }),
  );
  expect(
    (
      await apply(
        s.command("approval", {
          approvalId: randomUUID(),
          shapeManifestHash: state.shapeManifestHash,
          metadataOnly: true,
          acknowledgeUnresolvedGeometry: true,
          note: null,
        }),
      )
    ).status,
  ).toBe("applied");
  const reader = new RegulationPublishedReadRepository(db);
  const result = await reader.getPublished(s.caseId, 2);
  expect(result?.shapes).toEqual([]);
  expect(result?.geometries).toEqual([]);
  await db
    .delete(schema.regulationCaseValidations)
    .where(eq(schema.regulationCaseValidations.caseId, s.caseId));
  await expect(reader.getPublished(s.caseId, 2)).rejects.toThrow(
    "published validation receipt missing",
  );
}, 5000);
