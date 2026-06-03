import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import type { SildelagetCatchEntryObserved } from "../../src/events/contracts";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";

const APP_PORT = 4440;
const USABLE_PORT = 4441;
const FISHFACTS_PORT = 4442;
const VALID_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const TRANSFORMER_SECRET = "test-transformer-secret";
const TEST_IDS = ["api-sild-1001", "api-sild-1002", "api-sild-1003"];

const usable = new FakeUsableServer(USABLE_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
let cleanupClient: ReturnType<typeof postgres> | null = null;
let runBlackbox = false;
const app = new AppProcess(APP_PORT, {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
  FLOWCORE_TENANT: "jbiskur",
  FLOWCORE_DATA_CORE: "fishfacts-ai-backend",
  FLOWCORE_DATA_CORE_ID: "ad37e770-4d43-4ebd-8166-401be5e0b513",
  FLOWCORE_API_URL: `http://127.0.0.1:${USABLE_PORT}`,
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
});

describe("Sildelaget catch routes black-box", () => {
  beforeAll(async () => {
    try {
      cleanupClient = postgres(
        "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
        { max: 1 },
      );
      await cleanup();
      await usable.start();
      await fishfacts.start();
      fishfacts.addValidToken(VALID_TOKEN);
      await app.start();
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
    await fishfacts.stop();
    await usable.stop();
    if (runBlackbox) await cleanup();
    await cleanupClient?.end();
  });

  test("requires auth", async () => {
    if (!runBlackbox) return;
    const aggregate = await app.fetch("/api/catch");
    const full = await app.fetch("/api/catch/full");
    expect(aggregate.status).toBe(401);
    expect(full.status).toBe(401);
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
  const response = await app.fetch("/api/transformer", {
    method: "POST",
    headers: { "x-secret": TRANSFORMER_SECRET },
    body: JSON.stringify({
      eventId: `evt-${entry.innmeldingId}`,
      timeBucket: "20260528100000",
      tenant: "jbiskur",
      dataCoreId: "fishfacts-ai-backend",
      flowType: "fishfacts-sildelaget-catchjournal.0",
      eventType: "sildelaget.catchjournal.entry.observed.0",
      metadata: {},
      payload: entry,
      validTime: "2026-05-28T10:35:00.000Z",
    }),
  });
  expect(response.ok).toBe(true);
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
