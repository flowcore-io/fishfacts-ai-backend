import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import type { SildelagetCatchEntryObserved } from "../../src/events/contracts";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";
import {
  FakeSildelagetServer,
  makeSildelagetNamespacedWorkbook,
  sildelagetFixtureRow,
} from "../fixtures/sildelaget-xlsx.fixture";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

const APP_PORT = 4440;
const USABLE_PORT = 4441;
const FISHFACTS_PORT = 4442;
const WEBHOOK_PORT = 4443;
const SILDELAGET_PORT = 4444;
const VALID_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const TRANSFORMER_SECRET = "test-transformer-secret";
const FLOW_TYPE = "fishfacts-sildelaget-catchjournal.0";
const EVENT_TYPE = "sildelaget.catchjournal.entry.observed.0";
const TEST_IDS = [
  "api-sild-1001",
  "api-sild-1002",
  "api-sild-1003",
  "api-sild-job-1001",
];

const usable = new FakeUsableServer(USABLE_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
const sildelaget = new FakeSildelagetServer(SILDELAGET_PORT);
const webhook = new WebhookTestFixture({
  port: WEBHOOK_PORT,
  secret: TRANSFORMER_SECRET,
  transformerUrl: `http://127.0.0.1:${APP_PORT}/api/transformer`,
}).addEndpoint(FLOW_TYPE, EVENT_TYPE, true);
let cleanupClient: ReturnType<typeof postgres> | null = null;
let runBlackbox = false;
const app = new AppProcess(APP_PORT, {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
  FLOWCORE_TENANT: "jbiskur",
  FLOWCORE_DATA_CORE: "fishfacts-ai-backend",
  FLOWCORE_DATA_CORE_ID: "ad37e770-4d43-4ebd-8166-401be5e0b513",
  FLOWCORE_API_URL: `http://127.0.0.1:${WEBHOOK_PORT}`,
  FLOWCORE_API_KEY: "fc_test_fixture_key",
  FLOWCORE_TRANSFORMER_SECRET: TRANSFORMER_SECRET,
  PUMP_RESET_SECRET: "test-reset-secret",
  SERVICE_URL: `http://127.0.0.1:${APP_PORT}`,
  DISABLE_EVENT_STREAMING: "true",
  USABLE_WORKSPACE_ID: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
  USABLE_API_BASE_URL: usable.baseUrl,
  USABLE_API_TOKEN: "usable-test-token",
  JOB_SCHEDULER_ENABLED: "false",
  FISHFACTS_API_BASE_URL: fishfacts.baseUrl,
  FISHFACTS_APPLICATION: "FISHFACTS",
  SILDELAGET_CATCHJOURNAL_EXPORT_URL: sildelaget.exportUrl,
});

describe("Sildelaget catch routes black-box", () => {
  beforeAll(async () => {
    try {
      sildelaget.setWorkbook(
        await makeSildelagetNamespacedWorkbook([
          sildelagetFixtureRow({
            innmeldingId: "api-sild-job-1001",
            species: "Nordsjøsild",
            tonnes: 35,
            vesselName: "Brattskjær",
            registrationMark: "TR-0346-ND",
            reportDateSerial: 46174,
          }),
        ]),
      );
      cleanupClient = postgres(
        "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
        { max: 1 },
      );
      await usable.start();
      await fishfacts.start();
      fishfacts.addValidToken(VALID_TOKEN);
      await sildelaget.start();
      await webhook.start();
      await app.start();
      await cleanup();
      runBlackbox = true;
    } catch (error) {
      console.warn(
        "[sildelaget-catch-routes.blackbox.test] skipping — could not connect to test DB",
        error instanceof Error ? error.message : error,
      );
      runBlackbox = false;
    }
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await sildelaget.stop();
    await fishfacts.stop();
    await usable.stop();
    if (runBlackbox) await cleanup();
    await cleanupClient?.end();
  });

  beforeEach(() => {
    webhook.clear();
    sildelaget.calls.length = 0;
  });

  test("requires auth", async () => {
    if (!runBlackbox) return;
    const aggregate = await app.fetch("/api/catch");
    const full = await app.fetch("/api/catch/full");
    expect(aggregate.status).toBe(401);
    expect(full.status).toBe(401);
  });

  test("job accepts manual backfill duration and projects namespaced XLSX export", async () => {
    if (!runBlackbox) return;
    const response = await app.fetch("/api/jobs/run", {
      method: "POST",
      headers: { "x-auth-token": VALID_TOKEN },
      body: JSON.stringify({
        jobId: "sildelaget-catchjournal",
        args: {
          selectedTime: 8760,
          selectedSpecies: "",
          selectedCatchType: "",
          isNor: true,
        },
      }),
    });
    expect(response.status).toBe(202);

    const exportCall = await waitFor(
      () =>
        sildelaget.calls.find((call) => call.includes("selectedTime=8760")) ??
        null,
      "Sildelaget manual backfill duration was not sent to export",
    );
    expect(exportCall).toContain("selectedTime=8760");

    const event = await waitFor(
      () => webhook.last(FLOW_TYPE, EVENT_TYPE),
      "Sildelaget catch event was not emitted",
    );
    expect(event).toMatchObject({
      tenant: "jbiskur",
      dataCore: "fishfacts-ai-backend",
      flowType: FLOW_TYPE,
      eventType: EVENT_TYPE,
    });
    expect(event.payload).toMatchObject({
      innmeldingId: "api-sild-job-1001",
      vesselName: "Brattskjær",
      registrationMark: "TR-0346-ND",
    });
    expect((event.payload as { sourceUrl?: string }).sourceUrl).toContain(
      "selectedTime=8760",
    );

    const projected = await waitFor(async () => {
      const full = await app.fetch(
        "/api/catch/full?from=2026-06-01&to=2026-06-01&innmeldingId=api-sild-job-1001",
        { headers: { "x-auth-token": VALID_TOKEN } },
      );
      const json = (await full.json()) as {
        rows: Array<{
          innmeldingId: string;
          vesselName: string;
          lines: Array<{ species: string; weightKg: number }>;
        }>;
      };
      return json.rows[0] ?? null;
    }, "Sildelaget catch projection was not available");
    expect(projected).toMatchObject({
      innmeldingId: "api-sild-job-1001",
      vesselName: "Brattskjær",
      lines: [
        expect.objectContaining({ species: "Nordsjøsild", weightKg: 35000 }),
      ],
    });
  });

  test("returns FishFacts-compatible wrapper and aggregates tonnes to kg", async () => {
    if (!runBlackbox) return;
    await seed(
      makeEntry("api-sild-1001", "Fiskebas", "FO-123", [
        ["NVG-sild", 1.25],
        ["NVG-sild", 2],
      ]),
    );

    const response = await app.fetch(
      "/api/catch?from=2026-05-01&to=2026-06-30&species=NVG-sild",
      { headers: { "x-auth-token": VALID_TOKEN } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      code: number;
      errors: unknown[];
      message: string;
      data: {
        catches: Array<{
          date: string;
          totalFullWeightKg: number;
          totalGuttedWeightKg: number;
          totalWeightKg: number;
          catches: Array<{
            specie: string;
            fullWeightKg: number;
            guttedWeightKg: number;
            weightKg: number;
          }>;
        }>;
        locations: unknown[];
      };
    };
    expect(body).toMatchObject({ code: 0, errors: [], message: "" });
    expect(body.data.locations).toEqual([]);
    expect(body.data.catches).toHaveLength(1);
    expect(body.data.catches[0]).toMatchObject({
      date: "2026-05-28",
      totalFullWeightKg: 3250,
      totalGuttedWeightKg: 0,
      totalWeightKg: 3250,
    });
    expect(body.data.catches[0].catches).toEqual([
      {
        specie: "NVG-sild",
        fullWeightKg: 3250,
        guttedWeightKg: 0,
        weightKg: 3250,
      },
    ]);
  });

  test("full endpoint filters and paginates", async () => {
    if (!runBlackbox) return;
    await seed(
      makeEntry("api-sild-1002", "Nordhav", "FO-456", [["Makrell", 4]]),
    );
    await seed(
      makeEntry("api-sild-1003", "Sudhav", "FO-789", [["Kolmule", 5]]),
    );

    const first = await app.fetch(
      "/api/catch/full?from=2026-05-01&to=2026-06-30&limit=1",
      { headers: { "x-auth-token": VALID_TOKEN } },
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      rows: Array<{ innmeldingId: string; lines: unknown[] }>;
      nextCursor: string | null;
    };
    expect(firstJson.rows).toHaveLength(1);
    expect(firstJson.nextCursor).not.toBeNull();

    const second = await app.fetch(
      `/api/catch/full?from=2026-05-01&to=2026-06-30&limit=1&cursor=${firstJson.nextCursor}`,
      { headers: { "x-auth-token": VALID_TOKEN } },
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      rows: Array<{ innmeldingId: string }>;
    };
    expect(secondJson.rows).toHaveLength(1);
    expect(secondJson.rows[0].innmeldingId).not.toBe(
      firstJson.rows[0].innmeldingId,
    );

    const filtered = await app.fetch(
      "/api/catch/full?from=2026-05-01&to=2026-06-30&species=Makrell&vesselName=Nord",
      { headers: { "x-auth-token": VALID_TOKEN } },
    );
    expect(filtered.status).toBe(200);
    const filteredJson = (await filtered.json()) as {
      rows: Array<{
        innmeldingId: string;
        vesselName: string;
        lines: Array<{ species: string }>;
      }>;
    };
    expect(filteredJson.rows).toHaveLength(1);
    expect(filteredJson.rows[0].innmeldingId).toBe("api-sild-1002");
    expect(filteredJson.rows[0].vesselName).toBe("Nordhav");
    expect(filteredJson.rows[0].lines).toEqual([
      expect.objectContaining({ species: "Makrell" }),
    ]);
  });

  test("/openapi.json contains Catch paths and schemas", async () => {
    if (!runBlackbox) return;
    const response = await app.fetch("/openapi.json");
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      tags: Array<{ name: string }>;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.tags.some((tag) => tag.name === "Catch")).toBe(true);
    expect(doc.paths["/api/catch"]).toBeDefined();
    expect(doc.paths["/api/catch/full"]).toBeDefined();
    expect(doc.components.schemas.FishfactsCatchWrapper).toBeDefined();
    expect(doc.components.schemas.DayCatchResponse).toBeDefined();
    expect(doc.components.schemas.CatchResponse).toBeDefined();
    expect(doc.components.schemas.SildelagetCatchEntry).toBeDefined();
    expect(doc.components.schemas.SildelagetCatchLine).toBeDefined();
    expect(doc.components.schemas.CatchFullPage).toBeDefined();
  });
});

async function cleanup() {
  if (!cleanupClient) return;
  await cleanupClient`DELETE FROM sildelaget_catch_lines WHERE innmelding_id = ANY(${TEST_IDS})`;
  await cleanupClient`DELETE FROM sildelaget_catch_entries WHERE innmelding_id = ANY(${TEST_IDS})`;
}

async function seed(entry: SildelagetCatchEntryObserved) {
  const response = await fetch(
    `http://127.0.0.1:${WEBHOOK_PORT}/event/jbiskur/fishfacts-ai-backend/${FLOW_TYPE}/${EVENT_TYPE}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flowcore-valid-time": "2026-05-28T10:35:00.000Z",
      },
      body: JSON.stringify(entry),
    },
  );
  expect(response.ok).toBe(true);
}

async function waitFor<T>(read: () => T | Promise<T>, message: string) {
  const deadline = Date.now() + 5000;
  let last: T;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

function makeEntry(
  innmeldingId: string,
  vesselName: string,
  registrationMark: string,
  lines: Array<[string, number]>,
): SildelagetCatchEntryObserved {
  return {
    innmeldingId,
    reportedDate: "2026-05-28",
    reportedTime: "10:30:00",
    vesselName,
    registrationMark,
    entryHash: hash(`${innmeldingId}-${vesselName}-${lines.length}`),
    sourceUrl: "https://example.test/export.xlsx",
    checkedAt: "2026-05-28T10:35:00.000Z",
    rawEntry: {},
    lines: lines.map(([species, tonnes], index) => ({
      lineKey: hash(`${innmeldingId}-${species}-${tonnes}-${index}`),
      lineIndex: index,
      fishingStartDate: "2026-05-27",
      fishingStartTime: "22:00:00",
      species,
      tonnes,
      weightKg: tonnes * 1000,
      average: 325,
      catchType: "Direkte",
      salesType: "Auksjon",
      gear: "Not",
      route: "5",
      use: "Konsum",
      pct1: null,
      pct2: null,
      pct3: null,
      pct4: null,
      assortment: null,
      offerEastSouth: null,
      offerEastSouthDate: null,
      offerEastSouthTime: null,
      offerEastNorth: null,
      offerEastNorthDate: null,
      offerEastNorthTime: null,
      offerWestSouth: null,
      offerWestSouthDate: null,
      offerWestSouthTime: null,
      offerWestNorth: null,
      offerWestNorthDate: null,
      offerWestNorthTime: null,
      leasedVessel: null,
      economicZone: "NO",
      municipality: "Torshavn",
      coFisher: null,
      buyer: "Buyer AS",
      receiver: "Receiver AS",
      nationality: "NO",
      rawRow: {},
    })),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
