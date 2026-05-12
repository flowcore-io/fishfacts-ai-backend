import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";

const APP_PORT = 4430;
const USABLE_PORT = 4431;
const FISHFACTS_PORT = 4432;
const VALID_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";

const usable = new FakeUsableServer(USABLE_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
const app = new AppProcess(APP_PORT, {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
  FLOWCORE_TENANT: "jbiskur",
  FLOWCORE_DATA_CORE: "fishfacts-ai-backend",
  FLOWCORE_API_URL: `http://127.0.0.1:${USABLE_PORT}`,
  FLOWCORE_API_KEY: "fc_test_fixture_key",
  FLOWCORE_TRANSFORMER_SECRET: "test-transformer-secret",
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

const J67_BODY = `Steinryggen:
1. Nord 71 grader 10,000 minutter. Øst 024 grader 53,000 minutter.
2. Nord 71 grader 11,600 minutter. Øst 024 grader 53,700 minutter.`;

const J69_BODY =
  "Det er forbudt for norske fartøy å fiske i britisk sone i ICES´ statistikkområder 4, 2.a, 5.b, 6.a. og 6.b. i 2026.";

async function seed(eventPayload: {
  signature: string;
  title: string;
  url: string;
  status: "current" | "archived" | "unknown";
  jmNumber: string;
  bodyMarkdown: string;
}) {
  const res = await app.fetch("/api/transformer", {
    method: "POST",
    headers: { "x-secret": "test-transformer-secret" },
    body: JSON.stringify({
      eventId: `seed-${eventPayload.jmNumber}`,
      timeBucket: "20260101000000",
      tenant: "jbiskur",
      dataCoreId: "fishfacts-ai-backend",
      flowType: "fishfacts-announcement.0",
      eventType: "jmelding.announcement.discovered.0",
      metadata: {},
      payload: {
        ...eventPayload,
        checkedAt: new Date().toISOString(),
      },
      validTime: new Date().toISOString(),
    }),
  });
  expect(res.ok).toBe(true);
}

const TEST_JM_NUMBERS = ["j-67-blackbox", "j-69-blackbox"];

describe("J-meldinger geo routes black-box", () => {
  let cleanupClient: ReturnType<typeof postgres> | null = null;

  beforeAll(async () => {
    cleanupClient = postgres(
      "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
      { max: 1 },
    );
    await cleanupClient`DELETE FROM jmelding_geo WHERE jm_number = ANY(${TEST_JM_NUMBERS})`;
    await usable.start();
    await fishfacts.start();
    fishfacts.addValidToken(VALID_TOKEN);
    await app.start();
  });

  afterAll(async () => {
    await app.stop();
    await usable.stop();
    await fishfacts.stop();
    if (cleanupClient) {
      await cleanupClient`DELETE FROM jmelding_geo WHERE jm_number = ANY(${TEST_JM_NUMBERS})`;
      await cleanupClient.end();
    }
  });

  test("rejects unauthenticated requests", async () => {
    const res = await app.fetch("/api/jmeldinger/j-67-blackbox");
    expect(res.status).toBe(401);
  });

  test("ingests via /api/transformer and returns the geo record", async () => {
    await seed({
      signature: "blackbox-67",
      title: "J-67-blackbox",
      url: "https://www.fiskeridir.no/yrkesfiske/j-meldinger/j-67-blackbox",
      status: "current",
      jmNumber: "j-67-blackbox",
      bodyMarkdown: J67_BODY,
    });

    const res = await app.fetch("/api/jmeldinger/j-67-blackbox", {
      headers: { "x-auth-token": VALID_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jmNumber: string;
      hasGeo: boolean;
      bbox: number[] | null;
      areas: Array<{ name: string | null; points: unknown[] }>;
      geojson: unknown;
    };
    expect(body.jmNumber).toBe("j-67-blackbox");
    expect(body.hasGeo).toBe(true);
    expect(body.bbox).not.toBeNull();
    expect(body.areas.length).toBeGreaterThan(0);
    expect(body.geojson).not.toBeNull();
  });

  test("filters by hasGeo and supports bbox + near queries", async () => {
    await seed({
      signature: "blackbox-69",
      title: "J-69-blackbox",
      url: "https://www.fiskeridir.no/yrkesfiske/j-meldinger/j-69-blackbox",
      status: "current",
      jmNumber: "j-69-blackbox",
      bodyMarkdown: J69_BODY,
    });

    const headers = { "x-auth-token": VALID_TOKEN };

    const noGeo = await app.fetch(
      "/api/jmeldinger?hasGeo=false&q=j-69-blackbox",
      { headers },
    );
    expect(noGeo.status).toBe(200);
    const noGeoJson = (await noGeo.json()) as {
      rows: Array<{ jmNumber: string }>;
    };
    expect(noGeoJson.rows.some((r) => r.jmNumber === "j-69-blackbox")).toBe(
      true,
    );

    const bbox = await app.fetch("/api/jmeldinger?bbox=24,70,32,72", {
      headers,
    });
    expect(bbox.status).toBe(200);
    const bboxJson = (await bbox.json()) as {
      rows: Array<{ jmNumber: string }>;
    };
    expect(bboxJson.rows.some((r) => r.jmNumber === "j-67-blackbox")).toBe(
      true,
    );
    expect(bboxJson.rows.some((r) => r.jmNumber === "j-69-blackbox")).toBe(
      false,
    );

    const near = await app.fetch(
      "/api/jmeldinger?near=24.883,71.166&radiusKm=5",
      { headers },
    );
    expect(near.status).toBe(200);
    const nearJson = (await near.json()) as {
      rows: Array<{ jmNumber: string }>;
    };
    expect(nearJson.rows.some((r) => r.jmNumber === "j-67-blackbox")).toBe(
      true,
    );

    const conflict = await app.fetch("/api/jmeldinger?bbox=0,0,1,1&near=0,0", {
      headers,
    });
    expect(conflict.status).toBe(400);

    const invalidBbox = await app.fetch("/api/jmeldinger?bbox=not-a-bbox", {
      headers,
    });
    expect(invalidBbox.status).toBe(400);
  });
});
