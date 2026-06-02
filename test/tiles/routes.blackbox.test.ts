import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";

const APP_PORT = 4440;
const USABLE_PORT = 4441;
const FISHFACTS_PORT = 4442;
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

// 3+ vertices so the convex hull yields a polygon (not a line/point).
const J_TILE_BODY = `Tile-test-area:
1. Nord 71 grader 10,000 minutter. Øst 024 grader 53,000 minutter.
2. Nord 71 grader 11,600 minutter. Øst 024 grader 53,700 minutter.
3. Nord 71 grader 09,000 minutter. Øst 025 grader 10,000 minutter.
4. Nord 71 grader 12,500 minutter. Øst 024 grader 30,000 minutter.`;

const TILE_JM_NUMBER = "j-tile-blackbox";

async function seedTileFixture() {
  const res = await app.fetch("/api/transformer", {
    method: "POST",
    headers: { "x-secret": "test-transformer-secret" },
    body: JSON.stringify({
      eventId: `seed-${TILE_JM_NUMBER}`,
      timeBucket: "20260101000000",
      tenant: "jbiskur",
      dataCoreId: "fishfacts-ai-backend",
      flowType: "fishfacts-announcement.0",
      eventType: "jmelding.announcement.discovered.0",
      metadata: {},
      payload: {
        signature: "blackbox-tile",
        title: "J-Tile-Blackbox",
        url: "https://www.fiskeridir.no/yrkesfiske/j-meldinger/j-tile-blackbox",
        status: "current",
        jmNumber: TILE_JM_NUMBER,
        bodyMarkdown: J_TILE_BODY,
        checkedAt: new Date().toISOString(),
      },
      validTime: new Date().toISOString(),
    }),
  });
  expect(res.ok).toBe(true);
}

describe("MVT tile routes black-box", () => {
  let cleanupClient: ReturnType<typeof postgres> | null = null;

  beforeAll(async () => {
    cleanupClient = postgres(
      "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
      { max: 1 },
    );
    await cleanupClient`DELETE FROM jmelding_geo WHERE jm_number = ${TILE_JM_NUMBER}`;
    await usable.start();
    await fishfacts.start();
    fishfacts.addValidToken(VALID_TOKEN);
    await app.start();
    await seedTileFixture();
  });

  afterAll(async () => {
    await app.stop();
    await usable.stop();
    await fishfacts.stop();
    if (cleanupClient) {
      await cleanupClient`DELETE FROM jmelding_geo WHERE jm_number = ${TILE_JM_NUMBER}`;
      await cleanupClient.end();
    }
  });

  test("catalog requires auth", async () => {
    const res = await app.fetch("/api/tiles/catalog");
    expect(res.status).toBe(401);
  });

  test("catalog returns the jmelding-closures layer with header token", async () => {
    const res = await app.fetch("/api/tiles/catalog", {
      headers: { "x-auth-token": VALID_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      layers: Array<{ id: string; kind: string }>;
    };
    const jm = body.layers.find((l) => l.id === "jmelding-closures");
    expect(jm).toBeDefined();
    expect(jm?.kind).toBe("polygon");
  });

  test("tile request rejects when no token", async () => {
    const res = await app.fetch("/api/tiles/jmelding-closures/3/4/1.pbf");
    expect(res.status).toBe(401);
  });

  test("tile request honours ?token= query param and returns MVT bytes", async () => {
    const res = await app.fetch(
      `/api/tiles/jmelding-closures/3/4/1.pbf?token=${VALID_TOKEN}`,
    );
    expect([200, 204]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toBe(
        "application/vnd.mapbox-vector-tile",
      );
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.byteLength).toBeGreaterThan(0);
    }
  });

  test("unknown layer returns 404", async () => {
    const res = await app.fetch(
      `/api/tiles/does-not-exist/3/4/1.pbf?token=${VALID_TOKEN}`,
    );
    expect(res.status).toBe(404);
  });

  test("invalid tile coords return 400", async () => {
    const res = await app.fetch(
      `/api/tiles/jmelding-closures/abc/4/1.pbf?token=${VALID_TOKEN}`,
    );
    expect(res.status).toBe(400);
  });
});
