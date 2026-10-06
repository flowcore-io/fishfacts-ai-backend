import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import type { RegulationRevisionProposed } from "../../src/events/contracts";
import { canonicalDigest } from "../../src/events/json-digest";
import type { OfficialVector } from "../../src/events/official-vector";
import {
  SNAPSHOT_PART_EVENT_TYPE,
  type SnapshotPart,
  manifestOf,
  reconstructSnapshot,
  splitSnapshot,
} from "../../src/events/regulation-snapshot-parts";
import { RegulationCaseCommandRuntime } from "../../src/regulations/command-runtime";
import { caseIdFor } from "../../src/regulations/ids";
import { OfficialAreaRepository } from "../../src/regulations/official-area-repository";
import { officialSnapshotId } from "../../src/regulations/official-vector";
import {
  editableFieldsOfCase,
  snapshotOnlyFieldsOf,
} from "../../src/regulations/revision-fields";
import { RegulationRevisionProjector } from "../../src/regulations/revision-projector";
import { RegulationRevisionSnapshotRuntime } from "../../src/regulations/revision-snapshot-runtime";
import { TilesRepository } from "../../src/tiles/repository";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";
const { db, client } = createDb(DB_URL);
const ADMIN = "official-vector-admin";
const USER = "official-vector-user";
const SECRET = "official-vector-local-transformer";
const FLOW = "fishfacts-regulation-queue.0";
const APP_PORT = 18460;
const usable = new FakeUsableServer(18461);
const fishfacts = new FakeFishfactsServer(18462);
const webhook = new WebhookTestFixture({
  port: 18463,
  secret: SECRET,
  transformerUrl: `http://127.0.0.1:${APP_PORT}/api/transformer`,
})
  .addEndpoint(FLOW, SNAPSHOT_PART_EVENT_TYPE, true)
  .addEndpoint(FLOW, "regulation.case.validation.recorded.0", true)
  .addEndpoint(FLOW, "regulation.case.approval.recorded.0", true)
  .addEndpoint(FLOW, "regulation.case.revision.proposed.0", true)
  .addEndpoint(FLOW, "regulation.case.revision.pointer.moved.0", true)
  .addEndpoint(FLOW, "regulation.admin.action.recorded.0", true);
const app = new AppProcess(
  APP_PORT,
  {
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    FLOWCORE_TENANT: "official-local",
    FLOWCORE_DATA_CORE: "official-local",
    FLOWCORE_DATA_CORE_ID: "e5118253-2992-49ce-8073-63e53a8e8fea",
    FLOWCORE_API_URL: "http://127.0.0.1:18463",
    FLOWCORE_API_KEY: "fc_local_test_key",
    FLOWCORE_TRANSFORMER_SECRET: SECRET,
    PUMP_RESET_SECRET: "local-reset",
    SERVICE_URL: `http://127.0.0.1:${APP_PORT}`,
    DISABLE_EVENT_STREAMING: "true",
    USABLE_WORKSPACE_ID: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
    USABLE_API_BASE_URL: usable.baseUrl,
    USABLE_API_TOKEN: "usable-local-test-token",
    USABLE_CHAT_EMBED_URL: `${usable.baseUrl}/embed-chat`,
    INGESTION_EMBED_KEY: "local-embed",
    JOB_SCHEDULER_ENABLED: "false",
    FISHFACTS_API_BASE_URL: fishfacts.baseUrl,
    FISHFACTS_APPLICATION: "FISHFACTS",
  },
  20000,
);
const refs: string[] = [];
const body = `### § 1. Closure
Forbudet er avgrenset i vest av en rett linje mellom følgende posisjoner:
70° 00,000' N 025° 00,000' E
70° 05,000' N 025° 05,000' E
Herfra videre avgrenset i øst av rett linje mellom følgende posisjoner:
70° 10,000' N 025° 10,000' E
70° 15,000' N 025° 15,000' E
### § 6. Closure
Forbudet er avgrenset mellom følgende posisjoner:
70° 20,000' N 025° 20,000' E
70° 25,000' N 025° 25,000' E`;
const simple = {
  type: "MultiPolygon" as const,
  coordinates: [
    [
      [
        [25, 70],
        [26, 70],
        [26, 71],
        [25, 71],
        [25, 70],
      ],
      [
        [25.2, 70.2],
        [25.2, 70.3],
        [25.3, 70.3],
        [25.3, 70.2],
        [25.2, 70.2],
      ],
    ],
    [
      [
        [27, 70],
        [28, 70],
        [28, 71],
        [27, 71],
        [27, 70],
      ],
    ],
  ],
};
function largePolygon() {
  const outer: [number, number][] = Array.from({ length: 14000 }, (_, i) => {
    const a = (i / 14000) * Math.PI * 2;
    return [25 + Math.cos(a), 70 + Math.sin(a)];
  });
  outer.push(outer[0]);
  const holes: [number, number][][] = Array.from({ length: 108 }, (_, i) => {
    const x = 24.65 + (i % 12) * 0.06;
    const y = 69.75 + Math.floor(i / 12) * 0.06;
    return [
      [x, y],
      [x, y + 0.02],
      [x + 0.02, y + 0.02],
      [x + 0.02, y],
      [x, y],
    ];
  });
  return { type: "Polygon" as const, coordinates: [outer, ...holes] };
}
// Optional read-only local proof with captured provider bytes; CI uses the
// deterministic large shape, so tests never depend on a live external API.
const large = process.env.OFFICIAL_VECTOR_FIXTURE
  ? JSON.parse(readFileSync(process.env.OFFICIAL_VECTOR_FIXTURE, "utf8")).find(
      (p: { paragraph: number }) => p.paragraph === 6,
    ).geometry
  : largePolygon();
async function get(path: string, token = ADMIN) {
  return app.fetch(path, { headers: { "x-auth-token": token } });
}
async function post(path: string, data: unknown, token = ADMIN) {
  return app.fetch(path, {
    method: "POST",
    headers: { "x-auth-token": token },
    body: JSON.stringify(data),
  });
}
async function emitSource(ref: string, text: string) {
  const response = await app.fetch("/api/transformer", {
    method: "POST",
    headers: { "x-secret": SECRET },
    body: JSON.stringify({
      eventId: randomUUID(),
      flowType: "fishfacts-announcement.0",
      eventType: "jmelding.announcement.discovered.0",
      tenant: "official-local",
      dataCoreId: "e5118253-2992-49ce-8073-63e53a8e8fea",
      timeBucket: "20261006000000",
      validTime: new Date().toISOString(),
      metadata: {},
      payload: {
        signature: `official-vector-test:${ref}`,
        title: `Synthetic ${ref}`,
        url: "https://example.test/official-vector-law",
        status: "current",
        jmNumber: ref,
        region: "NO",
        bodyMarkdown: text,
        sourceBodyCompleteness: "complete",
        checkedAt: new Date().toISOString(),
        contentHash: canonicalDigest(text),
      },
    }),
  });
  expect(response.status).toBe(200);
}
async function seed(text = body) {
  const ref = `j-${900000 + refs.length}-${2026}`;
  refs.push(ref);
  const key = `fiskeridir-jmelding:${ref}`;
  await emitSource(ref, text);
  const caseId = caseIdFor(key);
  const detail = await (await get(`/api/regulations/cases/${caseId}`)).json();
  expect(detail.case.geometryModelVersion).toBe(0);
  return { caseId, ref, revisionId: detail.case.currentRevisionId as string };
}
async function cache(caseId: string, ref: string, omitSix = false) {
  return new OfficialAreaRepository(db).upsert(
    [
      {
        caseId,
        paragraph: 1,
        name: "Official §1",
        geojson: simple,
        vertexCount: 15,
        sourceMetadata: { sourceRef: ref, featureIds: ["11", "12"] },
      },
      ...(omitSix
        ? []
        : [
            {
              caseId,
              paragraph: 6,
              name: "Official §6",
              geojson: large,
              vertexCount: 14541,
              sourceMetadata: { sourceRef: ref, featureIds: ["16"] },
            },
          ]),
    ],
    new Date("2026-10-06T09:00:00.000Z"),
  );
}
async function detail(caseId: string) {
  return (await get(`/api/regulations/cases/${caseId}`)).json();
}
async function published(caseId: string, suffix = "") {
  return get(
    `/api/regulations/published/${caseId}?geometryVersion=2${suffix}`,
    USER,
  );
}
async function validate(
  caseId: string,
  revisionId: string,
  geometry?: Record<string, unknown>,
  validated = true,
) {
  const response = await post(
    `/api/regulations/cases/${caseId}/validations`,
    geometry
      ? {
          revisionId,
          scope: "geometry",
          geometryId: geometry.id,
          snapshotId: geometry.snapshotId,
          geometryHash: geometry.geometryHash,
          validated,
        }
      : { revisionId, scope: "legal", validated },
  );
  expect(response.status).toBe(202);
}
async function approve(
  caseId: string,
  revisionId: string,
  metadataOnly = false,
) {
  return post(`/api/regulations/cases/${caseId}/approval`, {
    revisionId,
    metadataOnly,
  });
}
async function clearOwnedCase(id: string) {
  await client`delete from regulation_snapshot_parts where assembly_id in (select assembly_id from regulation_snapshot_assemblies where case_id=${id})`;
  for (const table of [
    "regulation_case_approvals",
    "regulation_case_validations",
    "regulation_case_actions",
    "regulation_case_geometries",
    "regulation_case_revisions",
    "regulation_case_sources",
    "regulation_case_official_areas",
    "regulation_snapshot_assemblies",
    "regulation_revision_deliveries",
    "regulation_official_snapshots",
    "regulation_immutable_conflicts",
    "regulation_ordered_inputs",
    "regulation_cases",
  ])
    await client`delete from ${client(table)} where ${client(table === "regulation_cases" ? "id" : "case_id")}=${id}`;
}
beforeAll(async () => {
  await runMigrations(db, client);
  fishfacts.addValidToken(ADMIN, {
    username: "official-reviewer",
    authorities: ["ADMIN", "USER"],
  });
  fishfacts.addValidToken(USER, {
    username: "official-deckhand",
    authorities: ["USER"],
  });
  await usable.start();
  await fishfacts.start();
  await webhook.start();
  await app.start();
}, 30000);
afterAll(async () => {
  await app.stop();
  await webhook.stop();
  await fishfacts.stop();
  await usable.stop();
  for (const ref of refs) {
    const id = caseIdFor(`fiskeridir-jmelding:${ref}`);
    await clearOwnedCase(id);
    await client`delete from jmelding_geo where jm_number=${ref}`;
  }
  await client.end();
}, 30000);

test("mounted SDK path publishes exact official rings and parts, groups two printed §1 runs, and preserves a legacy pin through redraft", async () => {
  const { caseId, ref, revisionId } = await seed();
  let d = await detail(caseId);
  const legacyRows = d.revisions.find(
    (r: { id: string }) => r.id === revisionId,
  ).geometries;
  expect(legacyRows).toHaveLength(3);
  await validate(caseId, revisionId);
  for (const g of legacyRows) await validate(caseId, revisionId, g);
  expect((await approve(caseId, revisionId)).status).toBe(202);
  const oldPin = await (await published(caseId)).json();
  await cache(caseId, ref);
  const requestId = randomUUID();
  const start = await post(`/api/regulations/cases/${caseId}/reparse`, {
    baseRevisionId: revisionId,
    requestId,
  });
  expect(start.status).toBe(202);
  const proposal = await start.json();
  expect(proposal.revisionId).toBe(requestId);
  expect(proposal.areasParsed).toBe(2);
  expect(
    (
      await (
        await get(
          `/api/regulations/cases/${caseId}/revision-deliveries/${requestId}`,
        )
      ).json()
    ).status,
  ).toBe("applied");
  expect(await (await published(caseId)).json()).toEqual(oldPin);
  d = await detail(caseId);
  const rows = d.revisions.find(
    (r: { id: string }) => r.id === requestId,
  ).geometries;
  expect(rows).toHaveLength(2);
  expect(rows[0].points).toEqual([]);
  expect(
    rows[0].evidenceRuns.map((r: { points: unknown[] }) => r.points.length),
  ).toEqual([2, 2]);
  expect(rows[0].geojson).toEqual(simple);
  expect(rows[1].geojson).toEqual(large);
  expect(rows[1].geojson.coordinates).toHaveLength(109);
  expect(rows[1].provenance.sourceContentHash).toBe(canonicalDigest(body));
  const parts = webhook.events
    .filter(
      (e) =>
        e.eventType === SNAPSHOT_PART_EVENT_TYPE &&
        (e.payload as SnapshotPart).assemblyId === requestId,
    )
    .map((e) => e.payload as SnapshotPart);
  expect(parts.length).toBeGreaterThan(10);
  expect(
    parts.every((p) => Buffer.byteLength(JSON.stringify(p)) <= 60000),
  ).toBe(true);
  const decoded = reconstructSnapshot(manifestOf(parts[0]), parts) as {
    geometries: Array<{ officialVector: { geojson: unknown } }>;
  };
  expect(decoded.geometries[1].officialVector.geojson).toEqual(large);
  expect(
    (
      await post(`/api/regulations/cases/${caseId}/validations`, {
        revisionId: requestId,
        scope: "geometry",
        geometryId: rows[0].id,
        validated: true,
      })
    ).status,
  ).toBe(409);
  expect((await approve(caseId, requestId)).status).toBe(422);
  await validate(caseId, requestId);
  for (const g of rows) await validate(caseId, requestId, g);
  expect((await approve(caseId, requestId)).status).toBe(202);
  const pin = await (await published(caseId)).json();
  expect(pin.geometries.map((g: { geojson: unknown }) => g.geojson)).toEqual([
    simple,
    large,
  ]);
  expect(pin.snapshotManifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await get(`/api/regulations/published/${caseId}?geometryVersion=1`, USER))
      .status,
  ).toBe(409);
  expect(
    (await published(caseId, `&expectedPublishedRevisionId=${revisionId}`))
      .status,
  ).toBe(409);
  expect(
    (
      await published(
        caseId,
        `&expectedPublishedRevisionId=${requestId}&expectedSnapshotManifestHash=${pin.snapshotManifestHash}`,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await get(
        `/api/regulations/published/source/fiskeridir-jmelding/${ref}?geometryVersion=2&expectedSnapshotManifestHash=${"0".repeat(64)}`,
        USER,
      )
    ).status,
  ).toBe(409);
  const repeat = await post(`/api/regulations/cases/${caseId}/reparse`, {
    baseRevisionId: revisionId,
    requestId,
  });
  expect(repeat.status).toBe(202);
  expect((await repeat.json()).revisionId).toBe(requestId);
  const before = JSON.stringify(pin);
  await new OfficialAreaRepository(db).upsert(
    [
      {
        caseId,
        paragraph: 1,
        name: "New live drawing",
        geojson: { type: "Polygon", coordinates: simple.coordinates[0] },
        vertexCount: 10,
        sourceMetadata: { sourceRef: ref, featureIds: ["11"] },
      },
    ],
    new Date(),
  );
  expect(JSON.stringify(await (await published(caseId)).json())).toBe(before);
  const index = await get(`/api/jmeldinger/${ref}`, USER);
  expect(index.status).toBe(200);
  const indexBody = await index.json();
  const record = indexBody.data ?? indexBody;
  if (process.env.OFFICIAL_VECTOR_FRONTEND_FIXTURE) {
    await Bun.write(
      process.env.OFFICIAL_VECTOR_FRONTEND_FIXTURE,
      JSON.stringify({
        detail: await detail(caseId),
        published: pin,
        source: record,
      }),
    );
  }
  expect(record.publishedGeometry).toMatchObject({
    caseId,
    publishedRevisionId: requestId,
    snapshotManifestHash: pin.snapshotManifestHash,
    metadataOnly: false,
  });
  expect(record.hasGeo).toBe(false);
  expect(record.geojson).toBeNull();
  for (const path of [
    `/api/jmeldinger?q=${ref}`,
    "/api/jmeldinger?region=NO&includeAreas=true",
    "/api/jmeldinger?bbox=24,69,28,72&includeAreas=true",
  ]) {
    const response = await (await get(path, USER)).json();
    const items = response.rows ?? response.items ?? response.data;
    const entry = items.find((r: { jmNumber: string }) => r.jmNumber === ref);
    expect(entry.publishedGeometry).toEqual(record.publishedGeometry);
    if (path.includes("includeAreas")) expect(entry.areas).toEqual([]);
  }
  const listed = await (
    await get(
      "/api/regulations/published?geometryVersion=2&jurisdiction=NO",
      USER,
    )
  ).json();
  expect(
    listed.regulations.find((r: { id: string }) => r.id === caseId)
      .snapshotManifestHash,
  ).toBe(pin.snapshotManifestHash);
  const oldList = await (
    await get(
      "/api/regulations/published?geometryVersion=1&jurisdiction=NO",
      USER,
    )
  ).json();
  expect(oldList.regulations.some((r: { id: string }) => r.id === caseId)).toBe(
    false,
  );
  // A field-only redraft reuses the exact frozen shape, resets new validation,
  // and keeps all previously approved bytes pinned.
  const current = d.revisions.find((r: { id: string }) => r.id === requestId);
  const draft = await post(`/api/regulations/cases/${caseId}/revisions`, {
    baseRevisionId: requestId,
    fields: {
      ...editableFieldsOfCase(d.case, snapshotOnlyFieldsOf(current.fields)),
      displayName: "Reviewed closure",
    },
    geometries: null,
    justifications: { displayName: "Readable display name" },
  });
  expect(draft.status).toBe(202);
  const draftId = (await draft.json()).revisionId;
  const afterDraft = await detail(caseId);
  const copied = afterDraft.revisions.find(
    (r: { id: string }) => r.id === draftId,
  ).geometries;
  expect(copied.map((g: { snapshotId: string }) => g.snapshotId)).toEqual(
    rows.map((g: { snapshotId: string }) => g.snapshotId),
  );
  expect(copied.map((g: { evidenceRuns: unknown }) => g.evidenceRuns)).toEqual(
    rows.map((g: { evidenceRuns: unknown }) => g.evidenceRuns),
  );
  expect(afterDraft.case.geometryValidated).toBe(false);
  expect(afterDraft.case.regulatoryValidated).toBe(false);
  expect(JSON.stringify(await (await published(caseId)).json())).toBe(before);
  expect((await approve(caseId, draftId)).status).toBe(422);
  // No new reconstruction intake or worker-only barriers in the actual startup.
  expect(webhook.events.some((e) => e.eventType.includes("barrier"))).toBe(
    false,
  );
  expect(
    (await post(`/api/regulations/cases/${caseId}/reconstruction`, {})).status,
  ).toBe(404);
}, 30000);

test("missing official section remains visible and blocks ordinary approval; metadata-only publication has no drawable geometry", async () => {
  const { caseId, ref, revisionId } = await seed();
  await cache(caseId, ref, true);
  const response = await post(`/api/regulations/cases/${caseId}/reparse`, {
    baseRevisionId: revisionId,
    requestId: randomUUID(),
  });
  expect(response.status).toBe(202);
  const operation = await response.json();
  const d = await detail(caseId);
  const rows = d.revisions.find(
    (r: { id: string }) => r.id === operation.revisionId,
  ).geometries;
  expect(rows[1]).toMatchObject({
    geometrySource: "official-vector",
    resolutionStatus: "unresolved",
    geojson: null,
    points: [],
  });
  expect(rows[1].evidenceRuns).toHaveLength(1);
  await validate(caseId, operation.revisionId);
  await validate(caseId, operation.revisionId, rows[0]);
  expect(
    (
      await post(`/api/regulations/cases/${caseId}/validations`, {
        revisionId: operation.revisionId,
        scope: "geometry",
        geometryId: rows[1].id,
        validated: true,
      })
    ).status,
  ).toBe(409);
  expect((await approve(caseId, operation.revisionId)).status).toBe(422);
  expect((await approve(caseId, operation.revisionId, true)).status).toBe(202);
  expect((await (await published(caseId)).json()).geometries).toEqual([]);
}, 30000);

test("uncertain multipart acknowledgment restarts from exact cached bytes; concurrent stale candidate is durably refused", async () => {
  const { caseId, ref, revisionId } = await seed();
  await cache(caseId, ref);
  const operationId = randomUUID();
  const response = await post(`/api/regulations/cases/${caseId}/reparse`, {
    baseRevisionId: revisionId,
    requestId: operationId,
  });
  expect(response.status).toBe(202);
  const [delivery] =
    await client`select parts from regulation_revision_deliveries where id=${operationId}`;
  const parts = delivery.parts as SnapshotPart[];
  const payload = reconstructSnapshot(manifestOf(parts[0]), parts) as Record<
    string,
    unknown
  >;
  const losingId = randomUUID();
  const { splitSnapshot } = await import(
    "../../src/events/regulation-snapshot-parts"
  );
  const losing = splitSnapshot(
    {
      assemblyId: losingId,
      caseId,
      baseRevisionId: revisionId,
      revisionId: losingId,
    },
    { ...payload, revisionId: losingId },
  );
  const runtime = new RegulationRevisionSnapshotRuntime(
    db,
    new RegulationRevisionProjector(db),
  );
  for (const p of losing.slice(0, -1)) await runtime.handlePart(p);
  expect(await runtime.handlePart(losing[losing.length - 1])).toMatchObject({
    status: "refused",
    reason: "stale or foreign base revision",
  });
  let fail = true;
  const recorded: unknown[] = [];
  runtime.attach({
    ingest: async (_type, data) => {
      recorded.push(...data);
      if (fail) {
        fail = false;
        throw new Error("ack lost");
      }
      return data.map(() => randomUUID());
    },
  });
  await client`update regulation_revision_deliveries set status='pending',event_ids=null where id=${operationId}`;
  await expect(
    runtime.retry(caseId, operationId, "admin:official-reviewer", revisionId),
  ).rejects.toThrow("ack lost");
  const restarted = new RegulationRevisionSnapshotRuntime(
    db,
    new RegulationRevisionProjector(db),
  );
  restarted.attach({
    ingest: async (_type, data) => {
      recorded.push(...data);
      return data.map(() => randomUUID());
    },
  });
  await restarted.retry(
    caseId,
    operationId,
    "admin:official-reviewer",
    revisionId,
  );
  expect(recorded.slice(0, Math.min(8, parts.length))).toEqual(
    parts.slice(0, 8),
  );
  expect(recorded.slice(Math.min(8, parts.length))).toEqual(parts);
  await expect(
    restarted.retry(caseId, operationId, "admin:someone-else", revisionId),
  ).rejects.toThrow("identity conflict");
  expect(
    (
      await post(`/api/regulations/cases/${caseId}/reparse`, {
        baseRevisionId: revisionId,
        requestId: randomUUID(),
      })
    ).status,
  ).toBe(409);
}, 30000);

test("unpublished official candidates suppress coordinate hulls on detail, bulk and tiles without inventing a public pin", async () => {
  const { caseId, ref, revisionId } = await seed(
    body.replace(
      "70° 05,000' N 025° 05,000' E",
      "70° 05,000' N 025° 05,000' E\n70° 06,000' N 025° 02,000' E",
    ),
  );
  const tiles = new TilesRepository(db);
  // Record actual tile bytes before adoption, so this test detects a missing
  // suppression guard instead of passing merely because the fixture has no hull.
  const before = await tiles.getTile("jmelding-closures", 10, 583, 228);
  expect(before.length).toBeGreaterThan(0);
  await cache(caseId, ref, true);
  expect(
    (
      await post(`/api/regulations/cases/${caseId}/reparse`, {
        baseRevisionId: revisionId,
      })
    ).status,
  ).toBe(202);
  const source = await (await get(`/api/jmeldinger/${ref}`, USER)).json();
  expect(source.hasGeo).toBe(false);
  expect(source.geojson).toBeNull();
  expect(source.publishedGeometry).toBeUndefined();
  const bulk = await (
    await get("/api/jmeldinger?includeAreas=true&region=NO", USER)
  ).json();
  expect(
    bulk.rows.find((r: { jmNumber: string }) => r.jmNumber === ref).areas,
  ).toEqual([]);
  const after = await tiles.getTile("jmelding-closures", 10, 583, 228);
  expect(Buffer.from(after).includes(Buffer.from(ref))).toBe(false);
  expect(Buffer.from(before).includes(Buffer.from(ref))).toBe(true);
  expect((await published(caseId)).status).toBe(404);
}, 30000);

test("backdated withdrawal invalidates current review without rewriting already published approval evidence", async () => {
  const { caseId, ref, revisionId } = await seed();
  await cache(caseId, ref, true);
  const operation = await (
    await post(`/api/regulations/cases/${caseId}/reparse`, {
      baseRevisionId: revisionId,
    })
  ).json();
  await validate(caseId, operation.revisionId);
  expect((await approve(caseId, operation.revisionId, true)).status).toBe(202);
  const before = await (await published(caseId)).json();
  const projector = new RegulationRevisionProjector(db);
  await projector.handleValidationRecorded({
    validationId: randomUUID(),
    caseId,
    caseKey: `fiskeridir-jmelding:${ref}`,
    revisionId: operation.revisionId,
    scope: "legal",
    geometryId: null,
    validated: false,
    note: null,
    actor: "admin:fixture",
    recordedAt: "2000-01-01T00:00:00.000Z",
  });
  expect((await detail(caseId)).case.regulatoryValidated).toBe(false);
  expect((await approve(caseId, operation.revisionId, true)).status).toBe(422);
  expect(await (await published(caseId)).json()).toEqual(before);
}, 30000);

test("malformed authority topology is durably refused with no partial snapshot writes or pin changes", async () => {
  const { caseId, ref, revisionId } = await seed();
  await cache(caseId, ref, true);
  const first = await (
    await post(`/api/regulations/cases/${caseId}/reparse`, {
      baseRevisionId: revisionId,
    })
  ).json();
  const [delivery] =
    await client`select parts from regulation_revision_deliveries where id=${first.revisionId}`;
  const original = reconstructSnapshot(
    manifestOf(delivery.parts[0]),
    delivery.parts,
  ) as RegulationRevisionProposed;
  const before =
    await client`select id from regulation_official_snapshots where case_id=${caseId}`;
  const invalid: OfficialVector["geojson"] = {
    type: "Polygon" as const,
    coordinates: [
      [
        [25, 70],
        [26, 71],
        [25, 71],
        [26, 70],
        [25, 70],
      ],
    ],
  };
  const geometryHash = canonicalDigest(invalid);
  const vector = original.geometries[0].officialVector;
  if (!vector) throw new Error("resolved fixture snapshot missing");
  const { snapshotId: _old, ...content } = vector;
  const badVector = {
    ...content,
    geojson: invalid,
    geometryHash,
    provenance: { ...vector.provenance, sourceVersion: geometryHash },
  };
  const id = randomUUID();
  const payload = {
    ...original,
    revisionId: id,
    baseRevisionId: first.revisionId,
    geometries: [
      {
        ...original.geometries[0],
        officialVector: {
          ...badVector,
          snapshotId: officialSnapshotId(badVector),
        },
      },
      original.geometries[1],
    ],
  };
  const bytes = splitSnapshot(
    {
      assemblyId: id,
      caseId,
      baseRevisionId: first.revisionId,
      revisionId: id,
    },
    payload,
  );
  const runtime = new RegulationRevisionSnapshotRuntime(
    db,
    new RegulationRevisionProjector(db),
  );
  let result: unknown;
  for (const part of bytes) result = await runtime.handlePart(part);
  expect(result).toMatchObject({
    status: "refused",
    reason: "invalid official polygon topology",
  });
  expect((await detail(caseId)).case.currentRevisionId).toBe(first.revisionId);
  expect([
    ...(await client`select id from regulation_official_snapshots where case_id=${caseId}`),
  ]).toEqual([...before]);
  const [assembly] =
    await client`select status from regulation_snapshot_assemblies where assembly_id=${id}`;
  expect(assembly.status).toBe("refused");
  expect((await published(caseId)).status).toBe(404);
}, 30000);

test("source-delayed event replay restores the exact approved pin with empty delivery/cache/catalog state", async () => {
  const { caseId, ref, revisionId } = await seed();
  await cache(caseId, ref);
  const op = await (
    await post(`/api/regulations/cases/${caseId}/reparse`, {
      baseRevisionId: revisionId,
    })
  ).json();
  const current = await detail(caseId);
  const rows = current.revisions.find(
    (r: { id: string }) => r.id === op.revisionId,
  ).geometries;
  await validate(caseId, op.revisionId);
  for (const g of rows) await validate(caseId, op.revisionId, g);
  expect((await approve(caseId, op.revisionId)).status).toBe(202);
  const before = await (await published(caseId)).json();
  const events = webhook.events.filter(
    (e) => (e.payload as { caseId?: string }).caseId === caseId,
  );
  await clearOwnedCase(caseId);
  for (const event of events) {
    const response = await app.fetch("/api/transformer", {
      method: "POST",
      headers: { "x-secret": SECRET },
      body: JSON.stringify({
        eventId: randomUUID(),
        flowType: event.flowType,
        eventType: event.eventType,
        tenant: event.tenant,
        dataCoreId: "e5118253-2992-49ce-8073-63e53a8e8fea",
        timeBucket: "20261006000000",
        validTime: new Date().toISOString(),
        metadata: {},
        payload: event.payload,
      }),
    });
    expect(response.status).toBe(200);
  }
  const [deferred] =
    await client`select count(*)::int n from regulation_ordered_inputs where case_id=${caseId} and status='pending'`;
  expect(deferred.n).toBe(4); // legal + two closures + approval, in observed order
  expect((await published(caseId)).status).toBe(404);
  await emitSource(ref, body);
  const snapshots = new RegulationRevisionSnapshotRuntime(
    db,
    new RegulationRevisionProjector(db),
  );
  await snapshots.recover();
  const legacy = new RegulationCaseCommandRuntime(db);
  await legacy.recover();
  const after = await (await published(caseId)).json();
  expect(after).toEqual(before);
  const [delivery] =
    await client`select count(*)::int n from regulation_revision_deliveries where case_id=${caseId}`;
  expect(delivery.n).toBe(0);
  const [pending] =
    await client`select count(*)::int n from regulation_ordered_inputs where case_id=${caseId} and status='pending'`;
  expect(pending.n).toBe(0);
}, 30000);
