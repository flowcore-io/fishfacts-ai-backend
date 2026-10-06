import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { FlowcoreDataPump } from "@flowcore/data-pump";
import {
  InternalPathwayState,
  PathwayPump,
  PathwayRouter,
  PathwaysBuilder,
} from "@flowcore/pathways";
import { asc, eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import { REGULATION_FLOW_TYPE } from "../../src/events/contracts";
import type {
  CaseCommandInput,
  CommandPart,
} from "../../src/events/regulation-case-command";
import { CASE_COMMAND_PART_EVENT_TYPE } from "../../src/events/regulation-case-command";
import { CASE_COMMAND_BARRIER_EVENT_TYPE } from "../../src/events/regulation-command-barrier";
import type { PublishedSyncTrigger } from "../../src/jobs/published-sync-trigger";
import {
  registerLegacyRegulationPathways,
  registerOrderedCommandPathways,
} from "../../src/pathways";
import { RegulationCaseActionProjector } from "../../src/regulations/action-projector";
import type { RevisionShapeState } from "../../src/regulations/coastal-state";
import { RegulationCaseCommandRuntime } from "../../src/regulations/command-runtime";
import { caseIdFor, geometryIdFor } from "../../src/regulations/ids";
import { RegulationPublishedReadRepository } from "../../src/regulations/published-repository";
import { RegulationRevisionProjector } from "../../src/regulations/revision-projector";
import { RegulationVerdictProjector } from "../../src/regulations/verdict-projector";
import fixture from "./fixtures/complete-shape.json";
const { db, client } = createDb(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
);
const owned: string[] = [];
beforeAll(() => runMigrations(db, client));
afterAll(async () => {
  for (const id of owned) {
    for (const table of [
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
  await client.end();
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
  return {
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
test("installed SDK registration projects exact immutable approval, and event-only replay without operational cache restores pinned full geometry", async () => {
  const h = await harness();
  for (const data of [
    { validationId: randomUUID(), scope: "legal", validated: true, note: null },
    {
      validationId: randomUUID(),
      scope: "coverage",
      coverageHash: fixture.state.coverage.coverageHash,
      validated: true,
      note: null,
    },
    {
      validationId: randomUUID(),
      scope: "shape",
      shapeId: fixture.state.shapes[0].id,
      shapeHash: fixture.state.shapes[0].shapeHash,
      validated: true,
      note: null,
    },
  ])
    expect(
      (
        await h.apply(
          h.input(
            data.scope === "coverage" ? "coverage-validation" : "validation",
            data,
          ),
        )
      )?.status,
    ).toBe("applied");
  const approval = h.input("approval", {
    approvalId: randomUUID(),
    shapeManifestHash: fixture.state.shapeManifestHash,
    metadataOnly: false,
    note: null,
  });
  expect((await h.apply(approval))?.status).toBe("applied");
  const published = new RegulationPublishedReadRepository(db);
  const before = await published.getPublished(h.caseId, 2);
  expect(before?.shapes?.[0]?.geojson).toEqual(
    fixture.state.shapes[0].geojson as never,
  );
  const events = h.recorded.flat();
  for (const table of [
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
    .update(schema.regulationCases)
    .set({
      publishedRevisionId: null,
      publishedToUsersAt: null,
      regulatoryValidated: false,
      geometryValidated: false,
    })
    .where(eq(schema.regulationCases.id, h.caseId));
  const replay = new RegulationCaseCommandRuntime(db);
  for (const part of events.toReversed()) await replay.handlePart(part);
  const after = await published.getPublished(h.caseId, 2);
  expect(after?.shapes).toEqual(before?.shapes);
  expect(after?.sourceSignature).toEqual(before?.sourceSignature);
}, 5000);
test("serial SDK handler holds a failing last command, so the following barrier cannot report success from an exhausted processed marker", async () => {
  const h = await harness();
  const command = h.input("validation", {
    validationId: randomUUID(),
    scope: "legal",
    validated: true,
    note: null,
  });
  await h.runtime.submit(command);
  const parts = h.recorded.at(-1) ?? [];
  const original = h.runtime.projector.handle.bind(h.runtime.projector);
  let failing = true;
  let attempts = 0;
  h.runtime.projector.handle = async (payload) => {
    attempts++;
    if (failing) throw Error("fixture SQL unavailable");
    return original(payload);
  };
  const barrierId = randomUUID();
  let completed = false;
  // Capture the network data-source boundary; use the installed PathwayPump's
  // actual batch handler and the production-registered SDK router below it.
  let options: Parameters<typeof FlowcoreDataPump.create>[0] | undefined;
  const factory = spyOn(FlowcoreDataPump, "create").mockImplementation((o) => {
    options = o;
    return { start: async () => {}, stop: async () => {} } as never;
  });
  const sdkPump = new PathwayPump({
    stateManagerFactory: () => ({ getState: () => null, setState: () => {} }),
    concurrency: { byFlowType: { [REGULATION_FLOW_TYPE]: 1 } },
  });
  sdkPump.configure({
    tenant: "local-fixture",
    dataCore: "local-fixture",
    apiKey: "fc_local_fixture",
    baseUrl: "http://127.0.0.1:1",
    processEvent: async (_path, event) => {
      await h.process(event.eventType, event.payload, event.flowType);
    },
  });
  try {
    await sdkPump.start([
      {
        flowType: REGULATION_FLOW_TYPE,
        eventType: CASE_COMMAND_PART_EVENT_TYPE,
      },
      {
        flowType: REGULATION_FLOW_TYPE,
        eventType: CASE_COMMAND_BARRIER_EVENT_TYPE,
      },
    ]);
  } finally {
    factory.mockRestore();
  }
  if (!options?.processor?.handler)
    throw Error("SDK pump processor not registered");
  expect(options.processor.concurrency).toBe(1);
  const events = [
    ...parts.map((payload) => ({
      eventId: randomUUID(),
      flowType: REGULATION_FLOW_TYPE,
      eventType: CASE_COMMAND_PART_EVENT_TYPE,
      payload,
    })),
    {
      eventId: randomUUID(),
      flowType: REGULATION_FLOW_TYPE,
      eventType: CASE_COMMAND_BARRIER_EVENT_TYPE,
      payload: { barrierId, recordedAt: new Date().toISOString() },
    },
  ];
  const pump = Promise.resolve(options.processor.handler(events as never)).then(
    () => {
      completed = true;
    },
  );
  await new Promise((r) => setTimeout(r, 350));
  expect(attempts).toBeGreaterThan(1);
  expect(completed).toBe(false);
  expect(await h.runtime.receipt(command.commandId)).toBeNull();
  expect(
    await db
      .select()
      .from(schema.regulationCommandBarriers)
      .where(eq(schema.regulationCommandBarriers.id, barrierId)),
  ).toHaveLength(0);
  failing = false;
  await pump;
  await sdkPump.stop();
  expect(completed).toBe(true);
  expect((await h.runtime.receipt(command.commandId))?.status).toBe("applied");
}, 5000);
test("observed source changes fence admin allocation, then actual source adapter appends blocked immutable draft without changing approved pin", async () => {
  const h = await harness();
  for (const data of [
    { validationId: randomUUID(), scope: "legal", validated: true, note: null },
    {
      validationId: randomUUID(),
      scope: "coverage",
      coverageHash: fixture.state.coverage.coverageHash,
      validated: true,
      note: null,
    },
    {
      validationId: randomUUID(),
      scope: "shape",
      shapeId: fixture.state.shapes[0].id,
      shapeHash: fixture.state.shapes[0].shapeHash,
      validated: true,
      note: null,
    },
  ])
    await h.apply(
      h.input(
        data.scope === "coverage" ? "coverage-validation" : "validation",
        data,
      ),
    );
  await h.apply(
    h.input("approval", {
      approvalId: randomUUID(),
      shapeManifestHash: fixture.state.shapeManifestHash,
      metadataOnly: false,
      note: null,
    }),
  );
  const published = new RegulationPublishedReadRepository(db);
  const pin = await published.getPublished(h.caseId, 2);
  const { RegulationCaseProjector } = await import(
    "../../src/regulations/case-projector"
  );
  const source = new RegulationCaseProjector(db);
  const body = `${fixture.text}\nSynthetic changed source preserves printed typo 3,.000.`;
  const item = {
    signature: randomUUID(),
    jmNumber: h.sourceRef,
    title: "Changed exact synthetic source",
    url: "https://example.test/fixture",
    status: "current" as const,
    region: "NO" as const,
    checkedAt: new Date().toISOString(),
    bodyMarkdown: body,
    sourceBodyCompleteness: "complete" as const,
    areas: fixture.runs.map((r) => ({ name: r.name, points: r.points })),
  };
  expect((await source.project(item)).outcome).toBe("deferred");
  await expect(
    h.runtime.submit(
      h.input("validation", {
        scope: "legal",
        validationId: randomUUID(),
        validated: true,
        note: null,
      }),
    ),
  ).rejects.toThrow("pending");
  await h.runtime.recover();
  const sourceParts = h.recorded.at(-1) ?? [];
  for (const part of sourceParts)
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, h.caseId));
  expect(row.currentRevisionId).not.toBe(h.revisionId);
  expect(row.publishedRevisionId).toBe(h.revisionId);
  const [draft] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, row.currentRevisionId));
  expect(draft.snapshotText).toBe(body);
  expect(draft.shapeState).toMatchObject({
    geometryModelVersion: 1,
    shapes: [{ geojson: null, status: "blocked" }],
  });
  expect((await published.getPublished(h.caseId, 2))?.shapes).toEqual(
    pin?.shapes,
  );
  expect((await published.getPublished(h.caseId, 2))?.sourceSignature).toEqual(
    pin?.sourceSignature,
  );
}, 5000);
test("admin DTO and routes bind separate coverage/shape decisions and expose no optimistic validation before projection", async () => {
  const h = await harness();
  const { Hono } = await import("hono");
  const { createRegulationsRouter } = await import(
    "../../src/regulations/routes"
  );
  const { RegulationQueueReadRepository } = await import(
    "../../src/regulations/read-repository"
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
      commands: h.runtime,
      writer: {} as never,
      groups: {} as never,
      poi: {} as never,
      jobRunner: {} as never,
    }),
  );
  const post = (suffix: string, body: unknown) =>
    app.request(`/api/regulations/cases/${h.caseId}/${suffix}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post("coverage-validations", {
        revisionId: h.revisionId,
        coverageHash: "0".repeat(64),
        validated: true,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post("approval", {
        revisionId: h.revisionId,
        shapeManifestHash: fixture.state.shapeManifestHash,
      })
    ).status,
  ).toBe(409);
  const coverage = await post("coverage-validations", {
    revisionId: h.revisionId,
    coverageHash: fixture.state.coverage.coverageHash,
    validated: true,
  });
  expect(coverage.status).toBe(202);
  const before = await (
    await app.request(`/api/regulations/cases/${h.caseId}`)
  ).json();
  expect(before.revisions[0].coverageValidated).toBe(false);
  for (const part of h.recorded.at(-1) ?? [])
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  const after = await (
    await app.request(`/api/regulations/cases/${h.caseId}`)
  ).json();
  expect(after.revisions[0].coverageValidated).toBe(true);
  expect(after.revisions[0].shapes[0].shapeValidated).toBe(false);
  expect(
    (
      await post("validations", {
        revisionId: h.revisionId,
        scope: "geometry",
        geometryId: geometryIdFor(h.revisionId, 0),
        validated: true,
      })
    ).status,
  ).toBe(400);
  for (const data of [
    { scope: "legal", validated: true },
    {
      scope: "shape",
      shapeId: fixture.state.shapes[0].id,
      shapeHash: fixture.state.shapes[0].shapeHash,
      validated: true,
    },
  ]) {
    expect(
      (await post("validations", { revisionId: h.revisionId, ...data })).status,
    ).toBe(202);
    for (const part of h.recorded.at(-1) ?? [])
      await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  }
  expect(
    (
      await post("approval", {
        revisionId: h.revisionId,
        shapeManifestHash: fixture.state.shapeManifestHash,
      })
    ).status,
  ).toBe(202);
  for (const part of h.recorded.at(-1) ?? [])
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  expect(
    (await new RegulationPublishedReadRepository(db).getPublished(h.caseId, 2))
      ?.shapes?.[0].geojson,
  ).toEqual(fixture.state.shapes[0].geojson as never);
}, 5000);
test("exact modeled and historical metadata-only pins gate every raw geo index reader, including archived sources; explicit evidence remains non-drawable", async () => {
  const h = await harness();
  const { JMeldingGeoProjector } = await import(
    "../../src/jmelding/geo-projector"
  );
  const { JMeldingGeoRepository } = await import(
    "../../src/jmelding/geo-repository"
  );
  const item = {
    signature: randomUUID(),
    jmNumber: h.sourceRef,
    title: "Synthetic archived source",
    url: "https://example.test/fixture",
    status: "archived" as const,
    region: "NO" as const,
    checkedAt: new Date().toISOString(),
    bodyMarkdown: fixture.text,
    sourceBodyCompleteness: "complete" as const,
    areas: fixture.runs.map((r) => ({ name: r.name, points: r.points })),
  };
  await new JMeldingGeoProjector(db).project(item, null);
  await db
    .update(schema.regulationCases)
    .set({ publishedRevisionId: h.revisionId })
    .where(eq(schema.regulationCases.id, h.caseId));
  const geo = new JMeldingGeoRepository(db);
  const full = await geo.findByJmNumber(h.sourceRef);
  expect(full).toMatchObject({
    hasGeo: false,
    areas: [],
    geojson: null,
    publishedGeometry: {
      caseId: h.caseId,
      publishedRevisionId: h.revisionId,
      geometryModelVersion: 1,
    },
  });
  expect(await geo.findByJmNumber(h.sourceRef, true)).toMatchObject({
    drawable: false,
    publishedGeometry: { caseId: h.caseId },
  });
  const lists = [
    (await geo.list({ region: "NO", q: h.sourceRef, limit: 200 })).rows,
    await geo.listForDrawing({ region: "NO", status: "archived", limit: 1000 }),
    (
      await geo.findInBbox({
        minLon: 9,
        minLat: 59,
        maxLon: 15,
        maxLat: 65,
        region: "NO",
        status: "archived",
        limit: 200,
      })
    ).rows,
    (
      await geo.findNear({
        lon: 10,
        lat: 60,
        radiusKm: 1000,
        region: "NO",
        status: "archived",
        limit: 200,
      })
    ).rows,
  ];
  for (const list of lists)
    expect(list.find((r) => r.jmNumber === h.sourceRef)).toMatchObject({
      hasGeo: false,
      publishedGeometry: { caseId: h.caseId },
    });
  await db
    .update(schema.regulationCaseRevisions)
    .set({ geometryModelVersion: 0 })
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  await db
    .update(schema.regulationCases)
    .set({ publishedMetadataOnly: true })
    .where(eq(schema.regulationCases.id, h.caseId));
  expect(await geo.findByJmNumber(h.sourceRef)).toMatchObject({
    areas: [],
    geojson: null,
    hasGeo: false,
    publishedGeometry: { geometryModelVersion: 0, metadataOnly: true },
  });
  await db
    .update(schema.regulationCases)
    .set({ publishedRevisionId: null })
    .where(eq(schema.regulationCases.id, h.caseId));
  expect((await geo.findByJmNumber(h.sourceRef))?.hasGeo).toBe(true);
  await db
    .delete(schema.jmeldingGeo)
    .where(eq(schema.jmeldingGeo.jmNumber, h.sourceRef));
}, 5000);
test("versioned new Norwegian source genesis is ordered before domain creation and replays complete blocked state without land or delivery cache", async () => {
  const h = await harness();
  const { RegulationCaseProjector } = await import(
    "../../src/regulations/case-projector"
  );
  const { revisionIdFor } = await import("../../src/regulations/ids");
  const sourceRef = randomUUID();
  const caseId = caseIdFor(`fiskeridir-jmelding:${sourceRef}`);
  owned.push(caseId);
  const item = {
    signature: randomUUID(),
    jmNumber: sourceRef,
    title: "New synthetic Norwegian notice",
    url: "https://example.test/new-source",
    status: "current" as const,
    region: "NO" as const,
    orderedCaseInput: true as const,
    checkedAt: new Date().toISOString(),
    bodyMarkdown: fixture.text,
    sourceBodyCompleteness: "complete" as const,
    areas: fixture.runs.map((r) => ({ name: r.name, points: r.points })),
  };
  expect((await new RegulationCaseProjector(db).project(item)).outcome).toBe(
    "deferred",
  );
  expect(
    await db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, caseId)),
  ).toHaveLength(0);
  await h.runtime.recover();
  const parts =
    h.recorded.find((batch) => batch[0]?.part.caseId === caseId) ?? [];
  expect(parts.length).toBeGreaterThan(0);
  for (const part of parts) await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  const revisionId = revisionIdFor(item.signature);
  const [original] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, revisionId));
  expect(original).toMatchObject({
    geometryModelVersion: 1,
    snapshotText: fixture.text,
    shapeState: { shapes: [{ status: "blocked", geojson: null }] },
  });
  for (const table of [
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
    await db.delete(table).where(eq(table.caseId, caseId));
  await db
    .delete(schema.regulationCases)
    .where(eq(schema.regulationCases.id, caseId));
  const replay = new RegulationCaseCommandRuntime(db);
  for (const part of parts.toReversed()) await replay.handlePart(part);
  const [restored] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, revisionId));
  expect(restored?.shapeState).toEqual(original.shapeState);
  expect(restored?.snapshotText).toBe(original.snapshotText);
}, 5000);
test("delayed legacy legal event is durably retained before case/base exists and recovers original model0 behavior instead of silently discarding", async () => {
  const h = await harness();
  const { RegulationRevisionProjector } = await import(
    "../../src/regulations/revision-projector"
  );
  const revision = randomUUID();
  const validationId = randomUUID();
  const payload = {
    validationId,
    caseId: h.caseId,
    caseKey: `fiskeridir-jmelding:${h.sourceRef}`,
    revisionId: revision,
    scope: "legal" as const,
    geometryId: null,
    validated: true,
    note: null,
    actor: "admin:fixture",
    recordedAt: new Date().toISOString(),
  };
  await db
    .update(schema.regulationCases)
    .set({ geometryModelVersion: 0 })
    .where(eq(schema.regulationCases.id, h.caseId));
  await h.runtime.adaptLegacy("validation", randomUUID(), payload, () =>
    new RegulationRevisionProjector(db).handleValidationRecorded(payload),
  );
  expect(
    await db
      .select()
      .from(schema.regulationCaseValidations)
      .where(eq(schema.regulationCaseValidations.id, validationId)),
  ).toHaveLength(0);
  await h.runtime.recover();
  expect(
    await db
      .select()
      .from(schema.regulationCaseValidations)
      .where(eq(schema.regulationCaseValidations.id, validationId)),
  ).toHaveLength(0);
  const [base] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  await db.insert(schema.regulationCaseRevisions).values({
    ...base,
    id: revision,
    position: 1,
    sourceEventSignature: randomUUID(),
    geometryModelVersion: 0,
    shapeState: null,
  });
  await db
    .update(schema.regulationCases)
    .set({ currentRevisionId: revision })
    .where(eq(schema.regulationCases.id, h.caseId));
  await h.runtime.recover();
  expect(
    await db
      .select()
      .from(schema.regulationCaseValidations)
      .where(eq(schema.regulationCaseValidations.id, validationId)),
  ).toMatchObject([{ validated: true, scope: "legal", revisionId: revision }]);
}, 5000);
test("pending dependency inputs before the eight-item batch cannot starve a later ready source genesis", async () => {
  const h = await harness();
  const { stageOrderedInput } = await import(
    "../../src/regulations/ordered-inputs"
  );
  const { RegulationCaseProjector } = await import(
    "../../src/regulations/case-projector"
  );
  for (let i = 0; i < 10; i++) {
    const caseId = randomUUID();
    owned.push(caseId);
    await db.transaction((tx) =>
      stageOrderedInput(
        tx,
        caseId,
        "validation",
        randomUUID(),
        {
          caseId,
          revisionId: randomUUID(),
          scope: "legal",
          validated: true,
          validationId: randomUUID(),
          geometryId: null,
          note: null,
          actor: "admin:fixture",
          recordedAt: "2020-01-01T00:00:00.000Z",
        },
        "2020-01-01T00:00:00.000Z",
      ),
    );
  }
  const ref = randomUUID();
  const caseId = caseIdFor(`fiskeridir-jmelding:${ref}`);
  owned.push(caseId);
  await new RegulationCaseProjector(db).project({
    signature: randomUUID(),
    jmNumber: ref,
    title: "Ready late source",
    url: "https://example.test/late",
    status: "current",
    region: "NO",
    orderedCaseInput: true,
    checkedAt: new Date().toISOString(),
    bodyMarkdown: fixture.text,
    areas: fixture.runs.map((r) => ({ name: r.name, points: r.points })),
  });
  await h.runtime.recover();
  const parts =
    h.recorded.find((batch) => batch[0]?.part.caseId === caseId) ?? [];
  expect(parts.length).toBeGreaterThan(0);
  for (const part of parts) await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  expect(
    await db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, caseId)),
  ).toHaveLength(1);
}, 5000);
test("registered legacy metadata/applicability proposal expands an exact shape copy into a new immutable revision and resets decisions", async () => {
  const h = await harness();
  const { REGULATION_REVISION_PROPOSED_EVENT_TYPE } = await import(
    "../../src/events/contracts"
  );
  await h.apply(
    h.input("validation", {
      scope: "legal",
      validationId: randomUUID(),
      validated: true,
      note: null,
    }),
  );
  const [base] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  const revisionId = randomUUID();
  const payload = {
    caseId: h.caseId,
    caseKey: `fiskeridir-jmelding:${h.sourceRef}`,
    baseRevisionId: h.revisionId,
    revisionId,
    fields: {
      ...(base.fields as Record<string, unknown>),
      displayName: "Synthetic edited display name",
      applicability: { notes: "Synthetic reviewed applicability note" },
    },
    geometries: fixture.runs,
    changes: [
      { field: "displayName", justification: "Synthetic label" },
      { field: "applicability", justification: "Synthetic legal metadata" },
    ],
    actor: "admin:fixture",
    recordedAt: new Date().toISOString(),
  };
  // The event is a compact durable intent: no land/authority or shape payload.
  await h.process(REGULATION_REVISION_PROPOSED_EVENT_TYPE, payload);
  expect(
    await db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, revisionId)),
  ).toHaveLength(0);
  await h.runtime.recover();
  const parts = h.recorded.at(-1) ?? [];
  for (const part of parts) await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  const [copy] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, revisionId));
  expect(copy?.shapeState).toEqual(base.shapeState);
  expect(copy?.fields).toMatchObject({
    displayName: "Synthetic edited display name",
    applicability: { notes: "Synthetic reviewed applicability note" },
  });
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, h.caseId));
  expect(row).toMatchObject({
    currentRevisionId: revisionId,
    regulatoryValidated: false,
    geometryValidated: false,
  });
}, 5000);

for (const [name, requested] of [
  [
    "noncontiguous reorder",
    [
      { ...fixture.runs[1], position: 42 },
      { ...fixture.runs[0], position: 7 },
    ],
  ],
  ["removal", [{ ...fixture.runs[1], position: 42 }]],
] as const)
  test(`regression: admin route preserves explicit global positions and manifest (${name})`, async () => {
    const h = await harness();
    const { Hono } = await import("hono");
    const { createRegulationsRouter } = await import(
      "../../src/regulations/routes"
    );
    const { RegulationQueueReadRepository } = await import(
      "../../src/regulations/read-repository"
    );
    const {
      regulationRevisionProposedSchema,
      REGULATION_REVISION_PROPOSED_EVENT_TYPE,
    } = await import("../../src/events/contracts");
    const { sourceRunManifestHashOf } = await import(
      "../../src/regulations/coastal-state"
    );
    const [base] = await db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("auth", {
        user: { username: "fixture", authorities: ["ADMIN"] },
      } as never);
      await next();
    });
    let emitted: unknown;
    app.route(
      "/api/regulations",
      createRegulationsRouter({
        queue: new RegulationQueueReadRepository(db),
        commands: h.runtime,
        writer: {
          writeRegulationRevisionProposed: async (payload: unknown) => {
            emitted = regulationRevisionProposedSchema.parse(payload); // exact installed writer registration schema
            await h.process(REGULATION_REVISION_PROPOSED_EVENT_TYPE, emitted);
            return randomUUID();
          },
        } as never,
        groups: {} as never,
        poi: {} as never,
        jobRunner: {} as never,
      }),
    );
    const response = await app.request(
      `/api/regulations/cases/${h.caseId}/revisions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevisionId: h.revisionId,
          fields: base.fields,
          geometries: requested,
          justifications: {
            geometries: "Synthetic explicit run identity review",
          },
        }),
      },
    );
    expect(response.status).toBe(202);
    const { revisionId } = await response.json();
    expect((emitted as { geometries: unknown }).geometries).toMatchObject(
      requested.map((r) => ({ position: r.position, points: r.points })),
    );
    await h.runtime.recover();
    for (const p of h.recorded.at(-1) ?? [])
      await h.process(CASE_COMMAND_PART_EVENT_TYPE, p);
    const actual = await db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revisionId));
    const [revision] = await db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, revisionId));
    const expectedHash = sourceRunManifestHashOf([...requested]);
    const actualHash = (revision.shapeState as typeof fixture.state).shapes[0]
      .provenance.parameters.sourceRunManifestHash;
    console.log(
      "ROUTE_POSITION_REPRO",
      JSON.stringify({
        name,
        requested: requested.map((r) => r.position),
        persisted: actual.map((r) => r.position),
        expectedHash,
        actualHash,
      }),
    );
    expect({
      runs: actual
        .map((r) => ({ position: r.position, points: r.points }))
        .sort((a, b) => a.position - b.position),
      manifest: actualHash,
    }).toEqual({
      runs: [...requested]
        .map((r) => ({ position: r.position, points: r.points }))
        .sort((a, b) => a.position - b.position),
      manifest: expectedHash,
    });
  }, 5000);

test("regression: legacy published pin stays v1 compatible while current draft is model1", async () => {
  const h = await harness();
  const legacyId = randomUUID();
  const [base] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  await db.insert(schema.regulationCaseRevisions).values({
    ...base,
    id: legacyId,
    position: 1,
    geometryModelVersion: 0,
    shapeState: null,
    sourceEventSignature: randomUUID(),
  });
  for (const r of fixture.runs)
    await db.insert(schema.regulationCaseGeometries).values({
      ...r,
      id: geometryIdFor(legacyId, r.position),
      revisionId: legacyId,
      caseId: h.caseId,
    });
  await db
    .update(schema.regulationCases)
    .set({ publishedRevisionId: legacyId, publishedMetadataOnly: false })
    .where(eq(schema.regulationCases.id, h.caseId));
  const reader = new RegulationPublishedReadRepository(db);
  expect(
    (await reader.getPublished(h.caseId, 1))?.geometries.map((r) => r.points),
  ).toEqual(fixture.runs.map((r) => r.points));
  expect(
    (
      await reader.listPublished({
        status: "all",
        limit: 200,
        offset: 0,
        geometryVersion: 1,
      })
    ).regulations.some((r) => r.id === h.caseId),
  ).toBe(true);
  expect((await reader.getPublished(h.caseId, 2))?.geometryModelVersion).toBe(
    0,
  );
}, 5000);
test("regression: equal-clock later legal withdrawal retains causal order", async () => {
  const h = await harness();
  const { revisionIdFor } = await import("../../src/regulations/ids");
  const ids = [randomUUID(), randomUUID()].sort((a, b) =>
    revisionIdFor(`ordered-input:validation:${a}`).localeCompare(
      revisionIdFor(`ordered-input:validation:${b}`),
    ),
  );
  for (const [eventId, validated] of [
    [ids[1], true],
    [ids[0], false],
  ] as const) {
    const payload = {
      caseId: h.caseId,
      caseKey: `fiskeridir-jmelding:${h.sourceRef}`,
      revisionId: h.revisionId,
      validationId: randomUUID(),
      scope: "legal" as const,
      geometryId: null,
      validated,
      note: null,
      actor: "admin:fixture",
      recordedAt: "2026-10-06T12:00:00.000Z",
    };
    await h.runtime.adaptLegacy("validation", eventId, payload, () =>
      new RegulationRevisionProjector(db).handleValidationRecorded(payload),
    );
  }
  await h.runtime.recover();
  for (const batch of h.recorded)
    for (const p of batch) await h.process(CASE_COMMAND_PART_EVENT_TYPE, p);
  const [row] = await db
    .select()
    .from(schema.regulationCases)
    .where(eq(schema.regulationCases.id, h.caseId));
  const applied = await db
    .select()
    .from(schema.regulationCaseValidations)
    .where(eq(schema.regulationCaseValidations.caseId, h.caseId));
  expect(
    applied
      .sort((a, b) => (a.commandSequence ?? 0) - (b.commandSequence ?? 0))
      .map((v) => ({ sequence: v.commandSequence, validated: v.validated })),
  ).toEqual([
    { sequence: 1, validated: true },
    { sequence: 2, validated: false },
  ]);
  console.log("EQUAL_CLOCK_REPRO", row.regulatoryValidated);
  expect(row.regulatoryValidated).toBe(false);
}, 5000);

test("regression: metadata-only published pin is excluded from vector tiles", async () => {
  const h = await harness();
  await h.apply(
    h.input("validation", {
      validationId: randomUUID(),
      scope: "legal",
      validated: true,
      note: null,
    }),
  );
  await h.apply(
    h.input("approval", {
      approvalId: randomUUID(),
      shapeManifestHash: fixture.state.shapeManifestHash,
      metadataOnly: true,
      acknowledgeUnresolvedGeometry: true,
      note: null,
    }),
  );
  const { JMeldingGeoProjector } = await import(
    "../../src/jmelding/geo-projector"
  );
  const { JMeldingGeoRepository } = await import(
    "../../src/jmelding/geo-repository"
  );
  const { TilesRepository } = await import("../../src/tiles/repository");
  await new JMeldingGeoProjector(db).project(
    {
      signature: randomUUID(),
      title: "Review tile source",
      url: "https://example.test/tile",
      status: "current",
      region: "NO",
      jmNumber: h.sourceRef,
      checkedAt: new Date().toISOString(),
      bodyMarkdown: fixture.text,
      areas: fixture.runs.map((r) => ({
        name: null,
        points: r.points,
        kind: "closure" as const,
      })),
    },
    null,
  );
  const detail = await new JMeldingGeoRepository(db).findByJmNumber(
    h.sourceRef,
  );
  expect(detail?.hasGeo).toBe(false);
  const bytes = await new TilesRepository(db).getTile(
    "jmelding-closures",
    0,
    0,
    0,
  );
  const leaked = Buffer.from(bytes).includes(Buffer.from(h.sourceRef));
  console.log(
    "TILE_REPRO",
    JSON.stringify({
      sourceRef: h.sourceRef,
      detailSuppressed: detail?.hasGeo === false,
      tileBytes: bytes.length,
      tileIncludesSourceRef: leaked,
    }),
  );
  await db
    .delete(schema.jmeldingGeo)
    .where(eq(schema.jmeldingGeo.jmNumber, h.sourceRef));
  expect(leaked).toBe(false);
}, 5000);
test("regression: repeated pointer domain identity refuses instead of permanent SQL retry", async () => {
  const h = await harness();
  const data = { pointerMoveId: randomUUID(), toRevisionId: h.revisionId };
  expect((await h.apply(h.input("pointer", data)))?.status).toBe("applied");
  const second = h.input("pointer", data);
  await h.runtime.submit(second);
  let result: unknown;
  try {
    for (const p of h.recorded.at(-1) ?? [])
      result = await h.runtime.projector.handle(p);
  } catch (error) {
    result = { status: "threw", code: (error as { code: string }).code };
  }
  console.log("POINTER_REPRO", JSON.stringify(result));
  expect(result).toMatchObject({ status: "refused" });
}, 5000);

test("regression: modeled v1 detail supplies the required upgrade version", async () => {
  const h = await harness();
  await h.apply(
    h.input("validation", {
      validationId: randomUUID(),
      scope: "legal",
      validated: true,
      note: null,
    }),
  );
  await h.apply(
    h.input("approval", {
      approvalId: randomUUID(),
      shapeManifestHash: fixture.state.shapeManifestHash,
      metadataOnly: true,
      acknowledgeUnresolvedGeometry: true,
      note: null,
    }),
  );
  const { createPublishedRegulationsRouter } = await import(
    "../../src/regulations/published-routes"
  );
  const app = createPublishedRegulationsRouter({
    published: new RegulationPublishedReadRepository(db),
  });
  const response = await app.request(`/${h.caseId}`);
  expect(response.status).toBe(409);
  const body = await response.json();
  console.log("UPGRADE_REPRO", body);
  expect(body).toEqual({
    error: "geometry_client_upgrade_required",
    requiredGeometryVersion: 2,
  });
}, 5000);
test("regression: empty coastal endpoint inventory cannot authorize proposed output", async () => {
  const h = await harness();
  const state = structuredClone(fixture.state) as unknown as RevisionShapeState;
  const { shapeDigest, manifestDigest, joinConfigurationDigest } = await import(
    "../../src/regulations/coastal-state"
  );
  const shape = state.shapes[0];
  shape.boundary.mode = "lines-plus-coast";
  shape.boundary.straightRuns = [];
  shape.requiredEndpoints = [];
  shape.joinCandidates = [];
  shape.selectedJoinCandidateIds = [];
  shape.candidateEnumerationComplete = true;
  const faceId = randomUUID();
  shape.faceCandidates = [
    {
      id: faceId,
      geojson: shape.geojson as NonNullable<typeof shape.geojson>,
      areaM2: 1,
      coordinateCount: 20,
      holeCount: 2,
    },
  ];
  shape.faceEnumerationComplete = true;
  shape.selectedFaceIds = [faceId];
  shape.joinConfigurationHash = joinConfigurationDigest(shape as never);
  shape.shapeHash = shapeDigest(shape as never);
  state.shapeManifestHash = manifestDigest(state as never);
  const [base] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  const command = {
    ...h.input("proposal", {
      fields: base.fields,
      geometries: fixture.runs,
      changes: [
        {
          field: "geometries",
          justification: "Synthetic endpoint integrity test",
        },
      ],
      shapeState: state,
      snapshot: {
        text: base.snapshotText,
        url: base.snapshotUrl,
        fetchedAt: null,
        fragmentId: null,
      },
    }),
    revisionId: randomUUID(),
  };
  const result = await h.apply(command);
  console.log("EMPTY_ENDPOINT_REPRO", result?.status);
  expect(result?.status).toBe("refused");
}, 5000);

async function adminApp(h: Awaited<ReturnType<typeof harness>>) {
  const { Hono } = await import("hono");
  const { createRegulationsRouter } = await import(
    "../../src/regulations/routes"
  );
  const { RegulationQueueReadRepository } = await import(
    "../../src/regulations/read-repository"
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
      commands: h.runtime,
      writer: {} as never,
      groups: {} as never,
      poi: {} as never,
      jobRunner: {} as never,
    }),
  );
  return app;
}
test("approval status distinguishes exact applied/refused receipts from absent or foreign commands", async () => {
  const h = await harness();
  const app = await adminApp(h);
  const approvalId = randomUUID();
  const url = `/api/regulations/cases/${h.caseId}/approval-requests/${approvalId}`;
  expect(await (await app.request(url)).json()).toEqual({
    approvalId,
    commandId: approvalId,
    caseId: h.caseId,
    revisionId: null,
    shapeManifestHash: null,
    metadataOnly: null,
    status: "pending",
    reason: null,
  });
  const approval = {
    ...h.input("approval", {
      approvalId,
      shapeManifestHash: fixture.state.shapeManifestHash,
      metadataOnly: false,
      note: null,
    }),
    commandId: approvalId,
  };
  await h.runtime.submit(approval);
  expect((await (await app.request(url)).json()).status).toBe("pending");
  for (const part of h.recorded.at(-1) ?? [])
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  expect(await (await app.request(url)).json()).toMatchObject({
    approvalId,
    caseId: h.caseId,
    commandId: approvalId,
    revisionId: h.revisionId,
    shapeManifestHash: fixture.state.shapeManifestHash,
    metadataOnly: false,
    status: "refused",
  });
  const legal = h.input("validation", {
    validationId: randomUUID(),
    scope: "legal",
    validated: true,
    note: null,
  });
  await h.apply(legal);
  expect(
    (
      await app.request(
        `/api/regulations/cases/${h.caseId}/approval-requests/${legal.commandId}`,
      )
    ).status,
  ).toBe(404);
  const successId = randomUUID();
  await h.apply({
    ...h.input("approval", {
      approvalId: successId,
      shapeManifestHash: fixture.state.shapeManifestHash,
      metadataOnly: true,
      acknowledgeUnresolvedGeometry: true,
      note: null,
    }),
    commandId: successId,
  });
  expect(
    await (
      await app.request(
        `/api/regulations/cases/${h.caseId}/approval-requests/${successId}`,
      )
    ).json(),
  ).toMatchObject({
    approvalId: successId,
    revisionId: h.revisionId,
    status: "applied",
    metadataOnly: true,
  });
  const other = await harness();
  expect(
    (
      await (
        await adminApp(other)
      ).request(
        `/api/regulations/cases/${other.caseId}/approval-requests/${successId}`,
      )
    ).status,
  ).toBe(404);
  const lookup = spyOn(h.runtime, "approvalReceipt").mockRejectedValueOnce(
    Error("fixture SQL failure"),
  );
  expect((await app.request(url)).status).toBe(503);
  lookup.mockRestore();
}, 5000);

test("pointer domain conflict advances ordered tail and real common handler/barrier stays live", async () => {
  const h = await harness();
  const data = { pointerMoveId: randomUUID(), toRevisionId: h.revisionId };
  await h.apply(h.input("pointer", data));
  const collision = h.input("pointer", data);
  await h.runtime.submit(collision);
  const parts = h.recorded.at(-1) ?? [];
  const other = await harness();
  const next = other.input("validation", {
    validationId: randomUUID(),
    scope: "legal",
    validated: true,
    note: null,
  });
  await other.runtime.submit(next);
  const barrierId = randomUUID();
  const pump = (async () => {
    for (const part of parts)
      await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
    for (const part of other.recorded.at(-1) ?? [])
      await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
    await h.process(CASE_COMMAND_BARRIER_EVENT_TYPE, {
      barrierId,
      recordedAt: new Date().toISOString(),
    });
  })();
  await Promise.race([
    pump,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("common pump liveness exceeded 2s")), 2000),
    ),
  ]);
  expect((await h.runtime.receipt(collision.commandId))?.status).toBe(
    "refused",
  );
  expect((await other.runtime.receipt(next.commandId))?.status).toBe("applied");
  expect(
    await db
      .select()
      .from(schema.regulationCommandBarriers)
      .where(eq(schema.regulationCommandBarriers.id, barrierId)),
  ).toHaveLength(1);
  expect(
    (
      await h.apply(
        h.input("validation", {
          validationId: randomUUID(),
          scope: "legal",
          validated: false,
          note: null,
        }),
      )
    )?.status,
  ).toBe("applied");
}, 5000);

for (const clock of ["2026-10-06T11:59:00.000Z", "2026-10-06T12:00:00.000Z"])
  test(`intake observed order survives cache loss/event-only replay under clock ${clock}`, async () => {
    const h = await harness();
    for (const [recordedAt, validated] of [
      ["2026-10-06T12:00:00.000Z", true],
      [clock, false],
    ] as const) {
      const payload = {
        caseId: h.caseId,
        caseKey: `fiskeridir-jmelding:${h.sourceRef}`,
        revisionId: h.revisionId,
        validationId: randomUUID(),
        scope: "legal" as const,
        geometryId: null,
        validated,
        note: null,
        actor: "admin:fixture",
        recordedAt,
      };
      await h.process("regulation.case.validation.recorded.0", payload);
    }
    const intake = await db
      .select()
      .from(schema.regulationOrderedInputs)
      .where(eq(schema.regulationOrderedInputs.caseId, h.caseId))
      .orderBy(asc(schema.regulationOrderedInputs.observationOrder));
    expect(intake).toHaveLength(2);
    expect(intake[1].predecessorInputId).toBe(intake[0].id);
    await h.runtime.recover();
    for (const parts of h.recorded)
      for (const part of parts)
        await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
    expect(
      (
        await db
          .select()
          .from(schema.regulationCases)
          .where(eq(schema.regulationCases.id, h.caseId))
      )[0].regulatoryValidated,
    ).toBe(false);
    const events = h.recorded.flat();
    for (const table of [
      schema.regulationCaseValidations,
      schema.regulationCommandReceipts,
      schema.regulationCommandDeliveries,
      schema.regulationCommandEnvelopes,
      schema.regulationCommandTails,
      schema.regulationSnapshotAssemblies,
      schema.regulationOrderedInputs,
    ])
      await db.delete(table).where(eq(table.caseId, h.caseId));
    const replay = new RegulationCaseCommandRuntime(db);
    for (const part of events.toReversed()) await replay.handlePart(part);
    expect(
      (
        await db
          .select()
          .from(schema.regulationCases)
          .where(eq(schema.regulationCases.id, h.caseId))
      )[0].regulatoryValidated,
    ).toBe(false);
    expect(
      (
        await h.apply(
          h.input("approval", {
            approvalId: randomUUID(),
            shapeManifestHash: fixture.state.shapeManifestHash,
            metadataOnly: false,
            note: null,
          }),
        )
      )?.status,
    ).toBe("refused");
  }, 5000);

// Decode the actual MVT protobuf fields, without a new runtime dependency.
function protobufFields(
  bytes: Uint8Array,
): Array<{ field: number; value: number | Uint8Array }> {
  let offset = 0;
  const result: Array<{ field: number; value: number | Uint8Array }> = [];
  const integer = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (offset >= bytes.length) throw Error("truncated protobuf");
      const byte = bytes[offset++];
      value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
  };
  while (offset < bytes.length) {
    const tag = integer();
    const wire = tag & 7;
    const field = Math.floor(tag / 8);
    if (wire === 0) result.push({ field, value: integer() });
    else if (wire === 2) {
      const size = integer();
      const end = offset + size;
      if (end > bytes.length) throw Error("truncated protobuf field");
      result.push({ field, value: bytes.slice(offset, end) });
      offset = end;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw Error("unsupported protobuf wire");
  }
  return result;
}
function decodedTile(bytes: Uint8Array) {
  const result: Array<{
    strings: string[];
    types: number[];
    geometryLengths: number[];
  }> = [];
  for (const layer of protobufFields(bytes).filter((f) => f.field === 3)) {
    if (!(layer.value instanceof Uint8Array)) throw Error("invalid tile layer");
    const fields = protobufFields(layer.value);
    const strings = fields
      .filter((f) => f.field === 4)
      .flatMap((f) =>
        f.value instanceof Uint8Array
          ? protobufFields(f.value)
              .filter((v) => v.field === 1 && v.value instanceof Uint8Array)
              .map((v) => new TextDecoder().decode(v.value as Uint8Array))
          : [],
      );
    const features = fields
      .filter((f) => f.field === 2)
      .map((f) => protobufFields(f.value as Uint8Array));
    result.push({
      strings,
      types: features.flatMap((f) =>
        f.filter((v) => v.field === 3).map((v) => v.value as number),
      ),
      geometryLengths: features.flatMap((f) =>
        f
          .filter((v) => v.field === 4)
          .map((v) => (v.value as Uint8Array).length),
      ),
    });
  }
  return result;
}

test("mounted vector tiles gate published modeled/metadata-only pins and retain unreviewed, FO/IS and legacy pins with modeled drafts", async () => {
  const h = await harness();
  const { Hono } = await import("hono");
  const { JMeldingGeoProjector } = await import(
    "../../src/jmelding/geo-projector"
  );
  const { TilesRepository } = await import("../../src/tiles/repository");
  const { createTilesRouter } = await import("../../src/tiles/routes");
  const app = new Hono().route(
    "/api/tiles",
    createTilesRouter({
      tilesRepository: new TilesRepository(db),
      rasterTilesRepository: {} as never,
    }),
  );
  const item = {
    signature: randomUUID(),
    title: "Synthetic tile case",
    url: "https://example.test/tile",
    status: "current" as const,
    region: "NO" as const,
    jmNumber: h.sourceRef,
    checkedAt: new Date().toISOString(),
    bodyMarkdown: fixture.text,
    areas: fixture.runs.map((r) => ({
      name: null,
      points: r.points,
      kind: "closure" as const,
    })),
  };
  const geo = new JMeldingGeoProjector(db);
  await geo.project(item, null);
  const read = async () => {
    const response = await app.request(
      "/api/tiles/jmelding-closures/0/0/0.pbf",
    );
    expect([200, 204]).toContain(response.status);
    return decodedTile(new Uint8Array(await response.arrayBuffer()));
  };
  const visible = (tile: ReturnType<typeof decodedTile>) =>
    tile.some((l) => l.strings.includes(h.sourceRef));
  try {
    const unreviewed = await read();
    expect(visible(unreviewed)).toBe(true);
    expect(unreviewed.flatMap((l) => l.types)).toContain(3);
    expect(
      unreviewed.flatMap((l) => l.geometryLengths).every((n) => n > 0),
    ).toBe(true);
    await db
      .update(schema.regulationCases)
      .set({ publishedRevisionId: h.revisionId, publishedMetadataOnly: false })
      .where(eq(schema.regulationCases.id, h.caseId));
    expect(visible(await read())).toBe(false);
    for (const region of ["FO", "IS"] as const) {
      await geo.project({ ...item, signature: randomUUID(), region }, null);
      expect(visible(await read())).toBe(true);
    }
    await geo.project({ ...item, signature: randomUUID() }, null);
    const [base] = await db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
    const legacyId = randomUUID();
    await db.insert(schema.regulationCaseRevisions).values({
      ...base,
      id: legacyId,
      position: 1,
      geometryModelVersion: 0,
      shapeState: null,
      sourceEventSignature: randomUUID(),
    });
    await db
      .update(schema.regulationCases)
      .set({ publishedRevisionId: legacyId })
      .where(eq(schema.regulationCases.id, h.caseId));
    expect(visible(await read())).toBe(true); // current draft remains model1
    await db
      .update(schema.regulationCases)
      .set({ publishedMetadataOnly: true })
      .where(eq(schema.regulationCases.id, h.caseId));
    expect(visible(await read())).toBe(false);
  } finally {
    await db
      .delete(schema.jmeldingGeo)
      .where(eq(schema.jmeldingGeo.jmNumber, h.sourceRef));
  }
}, 5000);

test("manual route rejects duplicate and invalid explicit global run identities before recording an intent", async () => {
  const h = await harness();
  const app = await adminApp(h);
  const [base] = await db
    .select()
    .from(schema.regulationCaseRevisions)
    .where(eq(schema.regulationCaseRevisions.id, h.revisionId));
  for (const positions of [
    [42, 42],
    [-1, 7],
    [1.5, 7],
  ]) {
    const response = await app.request(
      `/api/regulations/cases/${h.caseId}/revisions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevisionId: h.revisionId,
          fields: base.fields,
          geometries: fixture.runs.map((r, i) => ({
            ...r,
            position: positions[i],
          })),
          justifications: { geometries: "Synthetic invalid identity" },
        }),
      },
    );
    expect(response.status).toBe(400);
  }
  expect(h.recorded).toHaveLength(0);
}, 5000);

test("same-case delayed original decision waits for its exact source revision without deadlocking causal intake", async () => {
  const h = await harness();
  const { revisionIdFor } = await import("../../src/regulations/ids");
  const { RegulationCaseProjector } = await import(
    "../../src/regulations/case-projector"
  );
  const signature = randomUUID();
  const target = revisionIdFor(signature);
  const payload = {
    caseId: h.caseId,
    caseKey: `fiskeridir-jmelding:${h.sourceRef}`,
    revisionId: target,
    validationId: randomUUID(),
    scope: "legal" as const,
    geometryId: null,
    validated: true,
    note: null,
    actor: "admin:fixture",
    recordedAt: "2026-10-06T12:00:00.000Z",
  };
  await h.process("regulation.case.validation.recorded.0", payload);
  await h.runtime.recover();
  expect(h.recorded).toHaveLength(0);
  await new RegulationCaseProjector(db).project({
    signature,
    jmNumber: h.sourceRef,
    title: "Exact delayed source dependency",
    url: "https://example.test/dependency",
    status: "current",
    region: "NO",
    checkedAt: new Date().toISOString(),
    bodyMarkdown: fixture.text,
    sourceBodyCompleteness: "complete",
    areas: fixture.runs.map((r) => ({ name: r.name, points: r.points })),
  });
  await h.runtime.recover();
  expect(h.recorded).toHaveLength(1);
  for (const part of h.recorded[0])
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  await h.runtime.recover();
  expect(h.recorded).toHaveLength(2);
  for (const part of h.recorded[1])
    await h.process(CASE_COMMAND_PART_EVENT_TYPE, part);
  const [decision] = await db
    .select()
    .from(schema.regulationCaseValidations)
    .where(eq(schema.regulationCaseValidations.id, payload.validationId));
  expect(decision).toMatchObject({
    validated: true,
    revisionId: target,
    commandSequence: 2,
  });
}, 5000);
