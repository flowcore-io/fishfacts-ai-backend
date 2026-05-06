import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { AppProcess } from "./fixtures/app-process";
import { FakeFishfactsServer } from "./fixtures/fake-fishfacts";
import { FakeUsableServer } from "./fixtures/fake-usable";

const APP_PORT = 4420;
const USABLE_PORT = 4421;
const FISHFACTS_PORT = 4422;
const VALID_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const TRANSFORMER_SECRET = "test-transformer-secret";
const PUMP_RESET_SECRET = "test-reset-secret";
const AUTH_TTL_MS = 1000;

const usable = new FakeUsableServer(USABLE_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
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
  PUMP_RESET_SECRET,
  SERVICE_URL: `http://127.0.0.1:${APP_PORT}`,
  DISABLE_EVENT_STREAMING: "true",
  USABLE_WORKSPACE_ID: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
  USABLE_API_BASE_URL: usable.baseUrl,
  USABLE_API_TOKEN: "usable-test-token",
  JOB_SCHEDULER_ENABLED: "false",
  FISHFACTS_API_BASE_URL: fishfacts.baseUrl,
  FISHFACTS_APPLICATION: "FISHFACTS",
  AUTH_CACHE_TTL_MS: String(AUTH_TTL_MS),
});

describe("Auth middleware black-box", () => {
  beforeAll(async () => {
    await usable.start();
    await fishfacts.start();
    fishfacts.addValidToken(VALID_TOKEN);
    await app.start();
  });

  beforeEach(() => {
    fishfacts.clear();
    fishfacts.restore();
  });

  afterAll(async () => {
    await app.stop();
    await fishfacts.stop();
    await usable.stop();
  });

  test("missing x-auth-token rejects with 401 and never calls upstream", async () => {
    const response = await app.fetch("/api/jobs/state");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing_auth_token" });
    expect(fishfacts.calls.length).toBe(0);
  });

  test("invalid token rejects with 401 and calls upstream once with required headers", async () => {
    const response = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": "definitely-not-valid" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_auth_token" });
    expect(fishfacts.calls.length).toBe(1);
    expect(fishfacts.calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v3/user/active",
      authToken: "definitely-not-valid",
      application: "FISHFACTS",
    });
  });

  test("valid token passes through to handler with both required headers", async () => {
    const response = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": VALID_TOKEN },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(fishfacts.calls.length).toBe(1);
    expect(fishfacts.calls[0]).toMatchObject({
      authToken: VALID_TOKEN,
      application: "FISHFACTS",
    });
  });

  test("cache hit: two valid requests result in exactly one upstream call", async () => {
    const token = "cache-hit-token";
    fishfacts.addValidToken(token);
    const first = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": token },
    });
    const second = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": token },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fishfacts.calls.length).toBe(1);
  });

  test("cache TTL expiry: after sleep > TTL the second request hits upstream again", async () => {
    const token = "ttl-expiry-token";
    fishfacts.addValidToken(token);
    const first = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": token },
    });
    expect(first.status).toBe(200);
    expect(fishfacts.calls.length).toBe(1);
    await Bun.sleep(AUTH_TTL_MS + 200);
    const second = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": token },
    });
    expect(second.status).toBe(200);
    expect(fishfacts.calls.length).toBe(2);
  });

  test("upstream outage returns 502 auth_upstream_unavailable", async () => {
    fishfacts.simulateOutage();
    const response = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": "fresh-token-not-cached" },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "auth_upstream_unavailable",
    });
  });

  test("invalid tokens are NOT cached: revoked token recovers on next request", async () => {
    const bogus = "revoked-token";
    const first = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": bogus },
    });
    expect(first.status).toBe(401);
    expect(fishfacts.calls.length).toBe(1);

    fishfacts.addValidToken(bogus);
    const second = await app.fetch("/api/jobs/state", {
      headers: { "x-auth-token": bogus },
    });
    expect(second.status).toBe(200);
    expect(fishfacts.calls.length).toBe(2);
  });

  test("public routes remain open without x-auth-token", async () => {
    const health = await app.fetch("/health");
    expect(health.status).toBe(200);

    const openapi = await app.fetch("/openapi.json");
    expect(openapi.status).toBe(200);

    expect(fishfacts.calls.length).toBe(0);
  });

  test("/api/transformer remains open to its own secret without x-auth-token", async () => {
    const wrong = await app.fetch("/api/transformer", {
      method: "POST",
      headers: { "x-secret": "wrong" },
      body: JSON.stringify({}),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(fishfacts.calls.length).toBe(0);
  });

  test("/reset remains open to its own secret without x-auth-token", async () => {
    const response = await app.fetch("/reset", {
      method: "POST",
      headers: { "x-pump-reset-secret": "wrong" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(fishfacts.calls.length).toBe(0);
  });
});
