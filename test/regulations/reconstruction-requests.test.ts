import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InternalPathwayState,
  PathwayRouter,
  PathwaysBuilder,
} from "@flowcore/pathways";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import { REGULATION_FLOW_TYPE } from "../../src/events/contracts";
import { canonicalDigest } from "../../src/events/json-digest";
import type {
  CaseCommandInput,
  CommandPart,
} from "../../src/events/regulation-case-command";
import { CASE_COMMAND_PART_EVENT_TYPE } from "../../src/events/regulation-case-command";
import type { PublishedSyncTrigger } from "../../src/jobs/published-sync-trigger";
import {
  registerLegacyRegulationPathways,
  registerOrderedCommandPathways,
} from "../../src/pathways";
import { RegulationCaseActionProjector } from "../../src/regulations/action-projector";
import { parseBoundaryInventory } from "../../src/regulations/boundary-parser";
import { CoastalReconstruction } from "../../src/regulations/coastal-reconstruction";
import {
  type RevisionShapeState,
  manifestDigest,
  shapeDigest,
} from "../../src/regulations/coastal-state";
import { RegulationCaseCommandRuntime } from "../../src/regulations/command-runtime";
import { caseIdFor, geometryIdFor } from "../../src/regulations/ids";
import { importLandDataset } from "../../src/regulations/land-dataset";
import { RegulationPublishedReadRepository } from "../../src/regulations/published-repository";
import { RegulationQueueReadRepository } from "../../src/regulations/read-repository";
import { reconstructionIds } from "../../src/regulations/reconstruction-request-projector";
import { RegulationReconstructionRequests } from "../../src/regulations/reconstruction-requests";
import { RegulationRevisionProjector } from "../../src/regulations/revision-projector";
import { createRegulationsRouter } from "../../src/regulations/routes";
import { RegulationVerdictProjector } from "../../src/regulations/verdict-projector";
import synthetic from "./fixtures/synthetic-coastal-complete.json";
const text = synthetic.text;
const runs = synthetic.runs;
const fixture = {
  text,
  runs,
  state: parseBoundaryInventory(
    randomUUID(),
    text,
    runs.map((r) => ({ ...r, paragraph: null })),
    true,
  ),
};
let datasetId: string;
const ownedDatasets: string[] = [];
let directory: string;

const { db, client } = createDb(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
);
const owned: string[] = [];
beforeAll(async () => {
  await runMigrations(db, client);
  directory = await mkdtemp(join(tmpdir(), "ff-reconstruction-test-"));
  datasetId = await reference();
});
afterAll(async () => {
  for (const id of owned) {
    for (const table of [
      schema.regulationReconstructionRequests,
      schema.regulationCaseApprovals,
      schema.regulationCaseValidations,
      schema.regulationCaseGeometries,
      schema.regulationCaseRevisions,
      schema.regulationCaseSources,
      schema.regulationCommandDeliveries,
      schema.regulationCommandReceipts,
      schema.regulationCommandEnvelopes,
      schema.regulationSnapshotAssemblies,
      schema.regulationCommandTails,
      schema.regulationOrderedInputs,
    ])
      await db.delete(table).where(eq(table.caseId, id));
    await db
      .delete(schema.regulationCases)
      .where(eq(schema.regulationCases.id, id));
  }
  for (const id of ownedDatasets) {
    await client`delete from regulation_land_features where dataset_id=${id}`;
    await client`delete from regulation_land_datasets where id=${id}`;
  }
  await client.end();
  await rm(directory, { recursive: true, force: true });
});
async function harness() {
  const sourceRef = randomUUID();
  const caseKey = `fiskeridir-jmelding:${sourceRef}`;
  const caseId = caseIdFor(caseKey);
  const revisionId = randomUUID();
  owned.push(caseId);
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
  const now = new Date();
  await db.insert(schema.regulationCases).values({
    id: caseId,
    caseKey,
    sourceRef,
    sourceType: "fiskeridir-jmelding",
    jurisdiction: "NO",
    title: fields.title,
    sourceUrl: "https://example.test/fixture",
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
    author: "test",
    sourceTextComplete: true,
    snapshotText: fixture.text,
    snapshotUrl: "https://example.test/fixture",
    sourceEventSignature: caseId,
    fields,
    geometryModelVersion: 1,
    shapeState: fixture.state,
  });
  for (const run of fixture.runs)
    await db.insert(schema.regulationCaseGeometries).values({
      ...run,
      id: geometryIdFor(revisionId, run.position),
      caseId,
      revisionId,
    });
  const runtime = new RegulationCaseCommandRuntime(db);
  const state = new InternalPathwayState();
  const builder = new PathwaysBuilder({
    tenant: "local-fixture",
    dataCore: "local-fixture",
    apiKey: "fc_local_fixture",
    baseUrl: "http://127.0.0.1:1",
    autoProvision: {
      dataCore: false,
      flowType: false,
      eventType: false,
      pathway: false,
    },
  });
  builder.withPathwayState(state);
  registerOrderedCommandPathways(builder, runtime, {
    schedule: () => {},
  } as unknown as PublishedSyncTrigger);
  registerLegacyRegulationPathways(
    builder,
    new RegulationVerdictProjector(db),
    new RegulationCaseActionProjector(db),
    new RegulationRevisionProjector(db),
    { schedule: () => {} } as unknown as PublishedSyncTrigger,
    runtime,
  );
  const router = new PathwayRouter(builder, "fixture-secret");
  const recorded: CommandPart[][] = [];
  let loseAck = false;
  const process = async (
    eventType: string,
    payload: unknown,
    flowType = REGULATION_FLOW_TYPE as string,
  ) =>
    router.processEvent(
      {
        eventId: randomUUID(),
        flowType,
        eventType,
        payload,
        time: new Date().toISOString(),
        tenant: "local-fixture",
        dataCore: "local-fixture",
      } as never,
      "fixture-secret",
    );
  runtime.attach({
    ingest: async (type, payloads, flow) => {
      for (const p of payloads) await process(type, p, flow);
      return payloads.map(() => randomUUID());
    },
    emit: async (parts) => {
      recorded.push([...parts]);
      if (loseAck) {
        loseAck = false;
        throw Error("simulated ack lost after durable emit");
      }
      return { eventIds: parts.map(() => randomUUID()) };
    },
  });
  const input = (
    operation: CaseCommandInput["operation"],
    data: unknown,
  ): CaseCommandInput => ({
    commandId: randomUUID(),
    caseId,
    baseRevisionId: revisionId,
    revisionId,
    operation,
    actor: "admin:fixture",
    data,
  });
  const apply = async (c: CaseCommandInput) => {
    await runtime.submit(c);
    for (const p of recorded.at(-1) ?? [])
      await process(CASE_COMMAND_PART_EVENT_TYPE, p);
    return runtime.receipt(c.commandId);
  };
  const requests = new RegulationReconstructionRequests(
    db,
    runtime,
    new CoastalReconstruction(client),
  );
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", {
      user: { username: "fixture", authorities: ["ADMIN"] },
    } as never);
    await next();
  });
  app.route(
    "/api/regulations",
    createRegulationsRouter({
      queue: new RegulationQueueReadRepository(db),
      commands: runtime,
      reconstruction: requests,
      writer: {} as never,
      groups: {} as never,
      poi: {} as never,
      jobRunner: {} as never,
    }),
  );
  let cursor = 0;
  const project = async () => {
    while (cursor < recorded.length) {
      for (const p of recorded[cursor++])
        await process(CASE_COMMAND_PART_EVENT_TYPE, p);
    }
  };
  const post = async (path: string, body: unknown) =>
    app.request(`/api/regulations/cases/${caseId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    setLoseAck: () => {
      loseAck = true;
    },
    app,
    requests,
    project,
    post,
    runtime,
    state,
    caseId,
    revisionId,
    input,
    apply,
    recorded,
    process,
    sourceRef,
  };
}

async function reference(extra?: {
  polygons?: string[];
  coverage?: number[][][];
}) {
  const polygons = extra?.polygons ?? synthetic.landWkts;
  let data = "";
  for (let i = 0; i < polygons.length; i++) {
    const [row] =
      await client`select encode(ST_AsBinary(ST_GeomFromText(${polygons[i]},4326),'NDR'),'hex') wkb`;
    data += `${JSON.stringify({ sourceFid: i, wkbHex: row.wkb })}\n`;
  }
  const file = join(directory, "synthetic.jsonl");
  await Bun.write(file, data);
  const content = {
    version: 1,
    archiveSha256: "a".repeat(64),
    extractSha256: createHash("sha256").update(data).digest("hex"),
    extractBytes: Buffer.byteLength(data),
    features: polygons.length,
    coordinates: polygons.length * 5,
    coverage: {
      type: "Polygon",
      coordinates: extra?.coverage ?? [
        [
          [27, 68],
          [27, 72],
          [23, 72],
          [23, 68],
          [27, 68],
        ],
      ],
    },
    crs: "EPSG:4326",
    dataDate: "2026-10-01T00:00:00Z",
    sourceUrl: "https://example.test/fictional-reference.zip",
    sourceReadme: "Fictional synthetic test reference, not actual OSM",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    copyrightUrl: "https://www.openstreetmap.org/copyright",
    tools: {
      python: "test",
      geopandas: "test",
      pyogrio: "test",
      gdal: "test",
      shapely: "test",
      geos: "test",
      pyproj: "test",
    },
    preparationScriptSha256: "b".repeat(64),
    preparation: "fictional test",
    command: "fictional test",
  };
  const manifest = {
    ...content,
    datasetId: `osm-land-v1-${canonicalDigest(content)}`,
  };
  ownedDatasets.push(manifest.datasetId);
  await importLandDataset(client, manifest, file);
  return manifest.datasetId;
}
test("mounted durable coastal requests stage exact joins and faces before full publication", async () => {
  const h = await harness();
  const requestId = randomUUID();
  const registered = await h.post("reconstruction", {
    requestId,
    baseRevisionId: h.revisionId,
    landDatasetId: datasetId,
  });
  expect(registered.status).toBe(202);
  const statusUrl = `/api/regulations/cases/${h.caseId}/reconstruction-requests/${requestId}`;
  const pending = await (await h.app.request(statusUrl)).json();
  expect(pending).toMatchObject({
    requestId,
    status: "pending",
    revisionId: null,
    error: null,
  });
  expect(typeof pending.recordedAt).toBe("string");
  await h.project();
  await h.requests.recover();
  expect((await (await h.app.request(statusUrl)).json()).status).toBe(
    "pending",
  );
  await h.project();
  const completed = await (await h.app.request(statusUrl)).json();
  expect(completed.status).toBe("completed");
  const [revision] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, completed.revisionId));
  const state = revision.shapeState as RevisionShapeState;
  const shape = state.shapes[0];
  expect(shape.candidateEnumerationComplete).toBe(true);
  expect(shape.geojson).toBeNull();
  expect(shape.selectedJoinCandidateIds).toEqual([]);
  const choices = shape.requiredEndpoints.map((e) => {
    const alternatives = shape.joinCandidates.filter(
      (c) =>
        c.endpoint.runPosition === e.runPosition &&
        c.endpoint.pointIndex === e.pointIndex,
    );
    expect(alternatives).toHaveLength(1);
    return alternatives[0].id;
  });
  for (const joinCandidateIds of [
    choices.slice(1),
    [...choices, choices[0]],
    choices.map(() => randomUUID()),
  ])
    expect(
      (
        await h.post("reconstruction/joins", {
          requestId: randomUUID(),
          baseRevisionId: completed.revisionId,
          shapeId: shape.id,
          shapeHash: shape.shapeHash,
          joinCandidateIds,
          justification: "Reject incomplete/duplicate/foreign choices",
        })
      ).status,
    ).toBe(400);
  const joinId = randomUUID();
  expect(
    (
      await h.post("reconstruction/joins", {
        requestId: joinId,
        baseRevisionId: completed.revisionId,
        shapeId: shape.id,
        shapeHash: shape.shapeHash,
        joinCandidateIds: choices,
        justification: "Fictional explicit enclosure review",
      })
    ).status,
  ).toBe(202);
  await h.project();
  await h.requests.recover();
  await h.project();
  const joined = await h.requests.status(h.caseId, joinId);
  expect(joined?.status).toBe("completed");
  const [joinedRevision] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, joined?.revisionId as string));
  const joinedState = joinedRevision.shapeState as RevisionShapeState;
  const joinedShape = joinedState.shapes[0];
  expect(joinedShape.faceEnumerationComplete).toBe(true);
  expect(joinedShape.selectedFaceIds).toEqual([]);
  expect(joinedShape.geojson).toBeNull();
  expect(joinedShape.faceCandidates.length).toBeGreaterThan(0);
  expect(
    (
      await h.post("reconstruction/faces", {
        requestId: randomUUID(),
        baseRevisionId: joinedRevision.id,
        shapeId: joinedShape.id,
        shapeHash: joinedShape.shapeHash,
        joinConfigurationHash: "f".repeat(64),
        faceIds: joinedShape.faceCandidates.map((f) => f.id),
        justification: "Reject stale join configuration",
      })
    ).status,
  ).toBe(400);
  for (const faceIds of [
    [],
    [randomUUID()],
    [joinedShape.faceCandidates[0].id, joinedShape.faceCandidates[0].id],
  ])
    expect(
      (
        await h.post("reconstruction/faces", {
          requestId: randomUUID(),
          baseRevisionId: joinedRevision.id,
          shapeId: joinedShape.id,
          shapeHash: joinedShape.shapeHash,
          joinConfigurationHash: joinedShape.joinConfigurationHash,
          faceIds,
          justification: "Reject empty/foreign/duplicate face choices",
        })
      ).status,
    ).toBe(400);
  const faceId = randomUUID();
  expect(
    (
      await h.post("reconstruction/faces", {
        requestId: faceId,
        baseRevisionId: joinedRevision.id,
        shapeId: joinedShape.id,
        shapeHash: joinedShape.shapeHash,
        joinConfigurationHash: joinedShape.joinConfigurationHash,
        faceIds: joinedShape.faceCandidates.map((f) => f.id),
        justification: "Explicit fictional face choice",
      })
    ).status,
  ).toBe(202);
  await h.project();
  await h.requests.recover();
  await h.project();
  const final = await h.requests.status(h.caseId, faceId);
  expect(final?.status).toBe("completed");
  const [finalRevision] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, final?.revisionId as string));
  const finalState = finalRevision.shapeState as RevisionShapeState;
  expect(finalState.shapes[0].geojson?.type).toBe("MultiPolygon");
  expect(finalState.shapes[0].geojson?.coordinates[0].length).toBeGreaterThan(
    1,
  );
  for (const data of [
    { validationId: randomUUID(), scope: "legal", validated: true, note: null },
    {
      validationId: randomUUID(),
      scope: "coverage",
      coverageHash: finalState.coverage.coverageHash,
      validated: true,
      note: null,
    },
    {
      validationId: randomUUID(),
      scope: "shape",
      shapeId: finalState.shapes[0].id,
      shapeHash: finalState.shapes[0].shapeHash,
      validated: true,
      note: null,
    },
  ]) {
    const input = {
      ...h.input(
        data.scope === "coverage" ? "coverage-validation" : "validation",
        data,
      ),
      baseRevisionId: finalRevision.id,
      revisionId: finalRevision.id,
    };
    expect((await h.apply(input))?.status).toBe("applied");
  }
  const approvalId = randomUUID();
  expect(
    (
      await h.apply({
        ...h.input("approval", {
          approvalId,
          shapeManifestHash: finalState.shapeManifestHash,
          metadataOnly: false,
          note: null,
        }),
        commandId: approvalId,
        baseRevisionId: finalRevision.id,
        revisionId: finalRevision.id,
      })
    )?.status,
  ).toBe("applied");
  expect(
    (await new RegulationPublishedReadRepository(db).getPublished(h.caseId, 2))
      ?.shapes?.[0]?.geojson,
  ).toEqual(finalState.shapes[0].geojson);
  const statusesBefore = await Promise.all(
    [requestId, joinId, faceId].map((id) => h.requests.status(h.caseId, id)),
  );
  const receiptBefore = await h.runtime.approvalReceipt(h.caseId, approvalId);
  // Event-only rebuild of every generated revision, decision, request and pin.
  // The synthetic initial source revision is the retained replay starting point.
  const assemblies = await db
    .select()
    .from(schema.regulationSnapshotAssemblies)
    .where(eq(schema.regulationSnapshotAssemblies.caseId, h.caseId));
  for (const assembly of assemblies)
    await db
      .delete(schema.regulationSnapshotParts)
      .where(
        eq(schema.regulationSnapshotParts.assemblyId, assembly.assemblyId),
      );
  for (const table of [
    schema.regulationReconstructionRequests,
    schema.regulationCaseApprovals,
    schema.regulationCaseValidations,
    schema.regulationCommandDeliveries,
    schema.regulationCommandReceipts,
    schema.regulationCommandEnvelopes,
    schema.regulationSnapshotAssemblies,
    schema.regulationCommandTails,
  ])
    await db.delete(table).where(eq(table.caseId, h.caseId));
  await db
    .delete(schema.regulationCaseGeometries)
    .where(
      and(
        eq(schema.regulationCaseGeometries.caseId, h.caseId),
        ne(schema.regulationCaseGeometries.revisionId, h.revisionId),
      ),
    );
  await db
    .delete(schema.regulationCaseRevisions)
    .where(
      and(
        eq(schema.regulationCaseRevisions.caseId, h.caseId),
        ne(schema.regulationCaseRevisions.id, h.revisionId),
      ),
    );
  await db
    .update(schema.regulationCases)
    .set({
      currentRevisionId: h.revisionId,
      publishedRevisionId: null,
      publishedMetadataOnly: false,
      regulatoryValidated: false,
      geometryValidated: false,
    })
    .where(eq(schema.regulationCases.id, h.caseId));
  await client`delete from regulation_land_features where dataset_id=${datasetId}`;
  await client`delete from regulation_land_datasets where id=${datasetId}`;
  try {
    for (const batch of [...h.recorded].reverse())
      for (const part of [...batch].reverse())
        await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
    expect(
      await Promise.all(
        [requestId, joinId, faceId].map((id) =>
          h.requests.status(h.caseId, id),
        ),
      ),
    ).toEqual(statusesBefore);
    expect(await h.runtime.approvalReceipt(h.caseId, approvalId)).toEqual(
      receiptBefore,
    );
    expect(
      (
        await new RegulationPublishedReadRepository(db).getPublished(
          h.caseId,
          2,
        )
      )?.shapes?.[0]?.geojson,
    ).toEqual(finalState.shapes[0].geojson);
    const noLand = new CoastalReconstruction(client);
    const generate = spyOn(noLand, "propose").mockImplementation(async () => {
      throw Error("replay must never regenerate");
    });
    await new RegulationReconstructionRequests(db, h.runtime, noLand).recover();
    expect(generate).not.toHaveBeenCalled();
    generate.mockRestore();
  } finally {
    await reference();
  }
}, 30000);

test("mounted pending delivery identity, immutable UUID retries and stale-result failure remain exact", async () => {
  const h = await harness();
  const requestId = randomUUID();
  const input = {
    requestId,
    baseRevisionId: h.revisionId,
    landDatasetId: datasetId,
  };
  expect((await h.post("reconstruction", input)).status).toBe(202);
  expect((await h.post("reconstruction", input)).status).toBe(202);
  expect(
    (await h.post("reconstruction", { ...input, landDatasetId: "alien" }))
      .status,
  ).toBe(409);
  await expect(
    h.requests.register(h.caseId, "admin:other", { ...input, kind: "start" }),
  ).rejects.toMatchObject({ code: "request_id_conflict" });
  const foreign = await harness();
  expect(
    (
      await foreign.app.request(
        `/api/regulations/cases/${foreign.caseId}/reconstruction-requests/${requestId}`,
      )
    ).status,
  ).toBe(404);
  const competing = randomUUID();
  expect(
    (await h.post("reconstruction", { ...input, requestId: competing })).status,
  ).toBe(202);
  await h.project();
  await h.requests.recover();
  await h.project();
  await h.requests.recover();
  await h.project();
  const statuses = await Promise.all(
    [requestId, competing].map((id) => h.requests.status(h.caseId, id)),
  );
  expect(statuses.map((s) => s?.status).sort()).toEqual([
    "completed",
    "failed",
  ]);
  const failed = statuses.find((s) => s?.status === "failed");
  expect(failed?.error).toMatchObject({
    error: "reconstruction_refused",
    reason: "stale base revision",
  });
  expect(failed?.revisionId).toBeNull();
  expect((await h.post("reconstruction", input)).status).toBe(202); // exact old request survives new current draft
}, 30000);

test("mounted reconstruction UUID spelling has one immutable request and readable status across stages", async () => {
  const h = await harness();
  const requestId = randomUUID();
  const body = {
    requestId: requestId.toUpperCase(),
    baseRevisionId: h.revisionId,
    landDatasetId: datasetId,
  };
  const response = await h.post("reconstruction", body);
  expect(response.status).toBe(202);
  const accepted = await response.json();
  const pending = await h.app.request(accepted.statusUrl);
  expect(pending.status).toBe(200);
  expect(accepted.requestId).toBe(requestId);
  expect(await pending.json()).toMatchObject({ requestId, status: "pending" });
  const originalParts = structuredClone(h.recorded.at(-1));
  for (const spelling of [
    requestId,
    requestId.slice(0, 8).toUpperCase() + requestId.slice(8),
  ]) {
    expect(
      (
        await h.post("reconstruction", {
          ...body,
          requestId: spelling,
          baseRevisionId: h.revisionId.toUpperCase(),
        })
      ).status,
    ).toBe(202);
    expect(h.recorded.at(-1)).toEqual(originalParts);
  }
  expect(
    (await h.post("reconstruction", { ...body, landDatasetId: "alien" }))
      .status,
  ).toBe(409);
  await expect(
    h.requests.register(h.caseId.toUpperCase(), "admin:other", {
      ...body,
      kind: "start",
    }),
  ).rejects.toMatchObject({ code: "request_id_conflict" });
  await h.project();
  await h.requests.recover();
  await h.project();
  const completed = await (
    await h.app.request(
      `/api/regulations/cases/${h.caseId.toUpperCase()}/reconstruction-requests/${requestId.toUpperCase()}`,
    )
  ).json();
  expect(completed).toMatchObject({ requestId, status: "completed" });
  expect((await h.post("reconstruction", body)).status).toBe(202);
  const row = async (id: string) => {
    const [revision] = await db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, id));
    return {
      ...revision,
      shapeState: revision.shapeState as RevisionShapeState,
    };
  };
  const generated = await row(completed.revisionId);
  const shape = generated.shapeState.shapes[0];
  const joinsId = randomUUID();
  const choices = shape.requiredEndpoints.map(
    (e) =>
      shape.joinCandidates.find(
        (c) =>
          c.endpoint.runPosition === e.runPosition &&
          c.endpoint.pointIndex === e.pointIndex,
      )?.id as string,
  );
  const joins = await h.post("reconstruction/joins", {
    requestId: joinsId.toUpperCase(),
    baseRevisionId: generated.id.toUpperCase(),
    shapeId: shape.id.toUpperCase(),
    shapeHash: shape.shapeHash,
    joinCandidateIds: choices.map((id) => id.toUpperCase()),
    justification: "Explicit synthetic choices; UUID spelling is not identity",
  });
  expect(joins.status).toBe(202);
  const joinedAck = await joins.json();
  expect((await h.app.request(joinedAck.statusUrl)).status).toBe(200);
  await h.project();
  await h.requests.recover();
  await h.project();
  const joinedStatus = await h.requests.status(h.caseId, joinsId);
  expect(joinedStatus?.status).toBe("completed");
  if (!joinedStatus?.revisionId) throw Error("joined revision missing");
  const joined = await row(joinedStatus.revisionId);
  const joinedShape = joined.shapeState.shapes[0];
  expect(joinedShape.selectedJoinCandidateIds).toEqual(choices);
  const facesId = randomUUID();
  const faces = await h.post("reconstruction/faces", {
    requestId: facesId.toUpperCase(),
    baseRevisionId: joined.id.toUpperCase(),
    shapeId: joinedShape.id.toUpperCase(),
    shapeHash: joinedShape.shapeHash,
    joinConfigurationHash: joinedShape.joinConfigurationHash,
    faceIds: joinedShape.faceCandidates.map((f) => f.id.toUpperCase()),
    justification: "Explicit synthetic face selection; no implicit choice",
  });
  expect(faces.status).toBe(202);
  const facesAck = await faces.json();
  expect((await h.app.request(facesAck.statusUrl)).status).toBe(200);
  await h.project();
  await h.requests.recover();
  await h.project();
  expect(await h.requests.status(h.caseId, facesId)).toMatchObject({
    status: "completed",
  });
}, 30000);

test("pre-fix accepted request spelling retains exact bytes and identity after cache loss", async () => {
  const h = await harness();
  const requestId = randomUUID();
  const oldSpelling = requestId.toUpperCase();
  const intent = {
    kind: "start" as const,
    requestId: oldSpelling,
    baseRevisionId: h.revisionId,
    landDatasetId: datasetId,
  };
  await h.runtime.submit({
    commandId: oldSpelling,
    caseId: h.caseId,
    baseRevisionId: h.revisionId,
    revisionId: reconstructionIds(oldSpelling).revisionId,
    operation: "request",
    actor: "admin:fixture",
    data: intent,
  });
  const originalParts = structuredClone(h.recorded.at(-1));
  const accepted = await h.post("reconstruction", {
    ...intent,
    kind: undefined,
    requestId,
  });
  expect(accepted.status).toBe(202);
  const ack = await accepted.json();
  expect((await h.app.request(ack.statusUrl)).status).toBe(200);
  expect(h.recorded.at(-1)).toEqual(originalParts);
  await h.project();
  await h.requests.recover();
  await h.project();
  expect(await h.requests.status(h.caseId, requestId)).toMatchObject({
    status: "completed",
  });
  await db
    .delete(schema.regulationCommandDeliveries)
    .where(eq(schema.regulationCommandDeliveries.caseId, h.caseId));
  expect(
    (await h.post("reconstruction", { ...intent, kind: undefined, requestId }))
      .status,
  ).toBe(202);
  expect(h.recorded.at(-1)).toEqual(originalParts);
  await expect(
    h.requests.register(h.caseId, "admin:other", { ...intent, requestId }),
  ).rejects.toMatchObject({ code: "request_id_conflict" });
  expect(
    (
      await h.post("reconstruction", {
        ...intent,
        kind: undefined,
        requestId,
        landDatasetId: "changed",
      })
    ).status,
  ).toBe(409);
  const deliveries = await db
    .select()
    .from(schema.regulationCommandDeliveries)
    .where(eq(schema.regulationCommandDeliveries.caseId, h.caseId));
  expect(deliveries.map((d) => d.commandId)).toEqual([oldSpelling]);
  expect(deliveries[0].sequence).toBe(1);
}, 30000);

test("producer crash after immutable result reservation retries exact bytes without land recomputation", async () => {
  const h = await harness();
  const requestId = randomUUID();
  expect(
    (
      await h.post("reconstruction", {
        requestId,
        baseRevisionId: h.revisionId,
        landDatasetId: datasetId,
      })
    ).status,
  ).toBe(202);
  await h.project();
  const delivery = spyOn(h.runtime.outbox, "deliver").mockImplementationOnce(
    async () => {
      throw Error("simulated producer crash before result emit");
    },
  );
  await expect(h.requests.recover()).rejects.toThrow(
    "simulated producer crash",
  );
  delivery.mockRestore();
  const geometry = new CoastalReconstruction(client);
  const recompute = spyOn(geometry, "propose").mockImplementation(async () => {
    throw Error("land must not be consulted for reserved result retry");
  });
  const restarted = new RegulationReconstructionRequests(
    db,
    h.runtime,
    geometry,
  );
  await restarted.recover();
  expect(recompute).not.toHaveBeenCalled();
  expect((await restarted.status(h.caseId, requestId))?.status).toBe("pending");
  await h.project();
  expect((await restarted.status(h.caseId, requestId))?.status).toBe(
    "completed",
  );
  recompute.mockRestore();
}, 30000);
test("real 65th endpoint component and uncovered frame refuse selectable candidate enumeration", async () => {
  const h = await harness();
  const state = parseBoundaryInventory(
    randomUUID(),
    text,
    runs.map((r) => ({ ...r, paragraph: null })),
    true,
  );
  const polygons = Array.from({ length: 65 }, (_, i) => {
    const x = 25.00001 + i * 0.000002;
    const y = 70.00001;
    return `POLYGON((${x} ${y},${x + 0.0000005} ${y},${x + 0.0000005} ${y + 0.0000005},${x} ${y + 0.0000005},${x} ${y}))`;
  });
  const overflow = await reference({ polygons });
  const geometry = new CoastalReconstruction(client);
  const blocked = await geometry.propose(state, text, runs, overflow);
  expect(blocked.shapes[0].blockingReasons).toContain("resource_limit");
  expect(blocked.shapes[0].candidateEnumerationComplete).toBe(false);
  expect(blocked.shapes[0].joinCandidates).toEqual([]);
  const restricted = await reference({
    coverage: [
      [
        [26, 69],
        [26, 71],
        [24, 71],
        [24, 69],
        [26, 69],
      ],
    ],
  });
  expect(
    (await geometry.propose(state, text, runs, restricted)).shapes[0]
      .blockingReasons,
  ).toContain("outside_land_coverage");
  expect(
    (await geometry.propose(state, text, runs, "missing-dataset")).shapes[0]
      .blockingReasons,
  ).toContain("land_dataset_unavailable");
  expect(await h.requests.status(h.caseId, randomUUID())).toBeNull();
}, 30000);

test("complete oversized proposal becomes durable resource failure without truncating or publishing geometry", async () => {
  const h = await harness();
  const requestId = randomUUID();
  expect(
    (
      await h.post("reconstruction", {
        requestId,
        baseRevisionId: h.revisionId,
        landDatasetId: datasetId,
      })
    ).status,
  ).toBe(202);
  await h.project();
  const geometry = new CoastalReconstruction(client);
  const generate = spyOn(geometry, "propose").mockImplementation(
    async (input) => {
      const state = structuredClone(input);
      state.shapes[0].provenance.parameters.testExactOversizedPayload =
        "x".repeat(17 * 1024 * 1024);
      state.shapes[0].shapeHash = shapeDigest(state.shapes[0]);
      state.shapeManifestHash = manifestDigest(state);
      return state;
    },
  );
  const worker = new RegulationReconstructionRequests(db, h.runtime, geometry);
  await worker.recover();
  await h.project();
  generate.mockRestore();
  expect(await worker.status(h.caseId, requestId)).toMatchObject({
    status: "failed",
    revisionId: null,
    error: { error: "resource_limit" },
  });
  const [caseRow] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, h.caseId));
  expect(caseRow.currentRevisionId).toBe(h.revisionId);
  expect(caseRow.publishedRevisionId).toBeNull();
  expect(h.recorded.at(-1)).toHaveLength(1);
}, 30000);

test("uncertain intent/result ingestion keeps original UUID and bytes across lost acknowledgements", async () => {
  const h = await harness();
  const requestId = randomUUID();
  const body = {
    requestId,
    baseRevisionId: h.revisionId,
    landDatasetId: datasetId,
  };
  h.setLoseAck();
  expect((await h.post("reconstruction", body)).status).toBe(503);
  const intentBytes = JSON.stringify(h.recorded[0]);
  const pending = await h.requests.status(h.caseId, requestId);
  expect(pending?.status).toBe("pending");
  expect(typeof pending?.recordedAt).toBe("string");
  await h.project();
  expect((await h.post("reconstruction", body)).status).toBe(202);
  expect(JSON.stringify(h.recorded[1])).toBe(intentBytes);
  await h.project();
  h.setLoseAck();
  await expect(h.requests.recover()).rejects.toThrow(
    "simulated ack lost after durable emit",
  );
  const resultBytes = JSON.stringify(h.recorded.at(-1));
  expect((await h.requests.status(h.caseId, requestId))?.status).toBe(
    "pending",
  );
  await h.runtime.outbox.recover();
  expect(JSON.stringify(h.recorded.at(-1))).toBe(resultBytes);
  await h.project();
  expect((await h.requests.status(h.caseId, requestId))?.status).toBe(
    "completed",
  );
  const revisions = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.caseId, h.caseId));
  expect(revisions).toHaveLength(2);
}, 30000);
test("partial full result bytes cannot complete request or change current revision", async () => {
  const h = await harness();
  const requestId = randomUUID();
  expect(
    (
      await h.post("reconstruction", {
        requestId,
        baseRevisionId: h.revisionId,
        landDatasetId: datasetId,
      })
    ).status,
  ).toBe(202);
  await h.project();
  const geometry = new CoastalReconstruction(client);
  const original = geometry.propose.bind(geometry);
  const generated = spyOn(geometry, "propose").mockImplementation(
    async (...args) => {
      const state = await original(...args);
      state.shapes[0].provenance.parameters.testTransportPadding = "x".repeat(
        50000,
      );
      state.shapes[0].shapeHash = shapeDigest(state.shapes[0]);
      state.shapeManifestHash = manifestDigest(state);
      return state;
    },
  );
  const worker = new RegulationReconstructionRequests(db, h.runtime, geometry);
  await worker.recover();
  const parts = h.recorded.at(-1) ?? [];
  expect(parts.length).toBeGreaterThan(1);
  await h.process(CASE_COMMAND_PART_EVENT_TYPE, parts[0]);
  expect((await worker.status(h.caseId, requestId))?.status).toBe("pending");
  const [before] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, h.caseId));
  expect(before.currentRevisionId).toBe(h.revisionId);
  for (const part of parts.slice(1).reverse())
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  expect((await worker.status(h.caseId, requestId))?.status).toBe("completed");
  expect(generated).toHaveBeenCalledTimes(1);
  generated.mockRestore();
}, 30000);

test("mounted missing text/reference refusals and bounded source inventory fail closed", async () => {
  const h = await harness();
  expect(
    (
      await h.post("reconstruction", {
        requestId: randomUUID(),
        baseRevisionId: h.revisionId,
        landDatasetId: "missing-dataset",
      })
    ).status,
  ).toBe(503);
  await db
    .update(schema.regulationCaseRevisions)
    .set({ snapshotText: null })
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  expect(
    (
      await h.post("reconstruction", {
        requestId: randomUUID(),
        baseRevisionId: h.revisionId,
        landDatasetId: datasetId,
      })
    ).status,
  ).toBe(422);
  await db
    .update(schema.regulationCaseRevisions)
    .set({
      snapshotText: Array.from(
        { length: 513 },
        (_, i) => `§ ${i + 1} FICTIONAL bounded source\nUnknown boundary.`,
      ).join("\n"),
    })
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  const requestId = randomUUID();
  expect(
    (
      await h.post("reconstruction", {
        requestId,
        baseRevisionId: h.revisionId,
        landDatasetId: datasetId,
      })
    ).status,
  ).toBe(202);
  await h.project();
  await h.requests.recover();
  await h.project();
  expect(await h.requests.status(h.caseId, requestId)).toMatchObject({
    status: "failed",
    revisionId: null,
    error: { error: "resource_limit" },
  });
}, 30000);
