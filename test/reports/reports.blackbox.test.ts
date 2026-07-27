import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";

const APP_PORT = 4460;
const USABLE_PORT = 4461;
const FISHFACTS_PORT = 4462;
const USER_TOKEN = "8f8b41f2-6a54-4e6b-9a52-2f8f8f2ce001";
const ADMIN_TOKEN = "8f8b41f2-6a54-4e6b-9a52-2f8f8f2ce002";
const WORKSPACE_ID = "d72eb385-f9cf-43ec-bca5-cc80432877f8";
const REPORT_FRAGMENT_TYPE_ID = "6c1d4a86-0d13-4c07-9e42-52d0f8b1a001";

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
  FLOWCORE_TRANSFORMER_SECRET: "test-transformer-secret",
  PUMP_RESET_SECRET: "test-reset-secret",
  SERVICE_URL: `http://127.0.0.1:${APP_PORT}`,
  DISABLE_EVENT_STREAMING: "true",
  USABLE_WORKSPACE_ID: WORKSPACE_ID,
  USABLE_API_BASE_URL: usable.baseUrl,
  USABLE_API_TOKEN: "usable-test-token",
  REPORT_FRAGMENT_TYPE_ID,
  JOB_SCHEDULER_ENABLED: "false",
  FISHFACTS_API_BASE_URL: fishfacts.baseUrl,
  FISHFACTS_APPLICATION: "FISHFACTS",
});

const VALID_REPORT = {
  sessionId: "conv_abc123",
  userDescription: "The map froze when I asked about herring catches.",
  contactEmail: "skipper@example.fo",
  appVersion: "6.7.0",
  userAgent: "Mozilla/5.0 (test)",
  viewport: { width: 1440, height: 900 },
  capturedAt: "2026-07-27T14:03:00.000Z",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "show me herring catches",
      createdAt: "2026-07-27T14:00:00.000Z",
    },
    {
      id: "m2",
      role: "assistant",
      content: "Here are the latest herring catches on the map.",
      createdAt: "2026-07-27T14:00:10.000Z",
    },
  ],
  toolCalls: [
    {
      tool: "draw_catch_bubbles",
      args: { species: "herring" },
      result: { drawn: 12 },
      calledAt: "2026-07-27T14:00:05.000Z",
      durationMs: 420,
    },
  ],
  networkRequests: [
    {
      method: "GET",
      url: "https://fishfacts-ai.usable.dev/api/catch?species=herring",
      status: 200,
      ok: true,
      startedAt: "2026-07-27T14:00:05.000Z",
      durationMs: 180,
    },
  ],
};

function postReport(token: string | null, body: unknown) {
  return app.fetch("/api/reports", {
    method: "POST",
    headers: token ? { "x-auth-token": token } : {},
    body: JSON.stringify(body),
  });
}

describe("Reports black-box", () => {
  beforeAll(async () => {
    await usable.start();
    await fishfacts.start();
    fishfacts.addValidToken(USER_TOKEN, {
      username: "deckhand@example.fo",
      authorities: ["FISHFACTS", "USER"],
    });
    fishfacts.addValidToken(ADMIN_TOKEN, {
      username: "gilli",
      authorities: ["FISHFACTS", "USER", "ADMIN"],
    });
    await app.start();
  });

  beforeEach(() => {
    usable.fragments.clear();
    usable.calls.length = 0;
  });

  afterAll(async () => {
    await app.stop();
    await fishfacts.stop();
    await usable.stop();
  });

  test("POST /api/reports with a valid session capture creates a Usable Report fragment (AC1)", async () => {
    const response = await postReport(USER_TOKEN, VALID_REPORT);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ status: "reported" });
    expect(typeof body.reportId).toBe("string");
    expect(typeof body.fragmentId).toBe("string");

    const created = usable.fragments.get(body.fragmentId);
    expect(created).toBeDefined();
    expect(created?.workspaceId).toBe(WORKSPACE_ID);
    expect(created?.fragmentTypeId).toBe(REPORT_FRAGMENT_TYPE_ID);
    // Frontmatter carries the lifecycle status + server-verified reporter.
    expect(created?.content).toContain("status: reported");
    expect(created?.content).toContain('sessionId: "conv_abc123"');
    expect(created?.content).toContain(
      'fishfactsUsername: "deckhand@example.fo"',
    );
    // Capture sections survive end-to-end.
    expect(created?.content).toContain("show me herring catches");
    expect(created?.content).toContain("draw_catch_bubbles");
    expect(created?.content).toContain("/api/catch?species=herring");
    expect(created?.tags).toContain("status:reported");
  });

  test("POST without a token is 401 and Usable is never called", async () => {
    const response = await postReport(null, VALID_REPORT);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing_auth_token" });
    expect(usable.calls.length).toBe(0);
  });

  test("POST with an invalid payload is 400 and nothing is created", async () => {
    const response = await postReport(USER_TOKEN, {
      userDescription: "no session id",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_payload");
    expect(usable.fragments.size).toBe(0);
  });

  test("an oversized capture is truncated, not rejected (PRD §6.3)", async () => {
    const oversized = {
      ...VALID_REPORT,
      messages: Array.from({ length: 250 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      })),
    };
    const response = await postReport(USER_TOKEN, oversized);
    expect(response.status).toBe(201);
    const body = await response.json();
    const created = usable.fragments.get(body.fragmentId);
    expect(created?.content).toContain("capturedMessageCount: 200");
    expect(created?.content).toContain("truncated: true");
    // Newest entries win: the tail survives, the head is dropped.
    expect(created?.content).toContain("message 249");
    expect(created?.content).not.toContain("message 40\n");
    expect(created?.content).toContain("dropped 50 oldest message(s)");
  });

  test("GET /api/reports as non-admin is 403 (proxy is admin-only)", async () => {
    const response = await app.fetch("/api/reports", {
      headers: { "x-auth-token": USER_TOKEN },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "forbidden",
      reason: "admin_required",
    });
  });

  test("GET /api/reports as admin lists submitted reports via the Usable proxy (AC2)", async () => {
    const first = await postReport(USER_TOKEN, VALID_REPORT);
    const second = await postReport(USER_TOKEN, {
      ...VALID_REPORT,
      sessionId: "conv_other",
      userDescription: undefined,
      contactEmail: undefined,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const response = await app.fetch("/api/reports", {
      headers: { "x-auth-token": ADMIN_TOKEN },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.returned).toBe(2);
    const sessions = body.reports.map(
      (report: { sessionId: string }) => report.sessionId,
    );
    expect(sessions).toContain("conv_abc123");
    expect(sessions).toContain("conv_other");
    const report = body.reports.find(
      (row: { sessionId: string }) => row.sessionId === "conv_abc123",
    );
    expect(report).toMatchObject({
      status: "reported",
      reporter: {
        username: "deckhand@example.fo",
        email: "skipper@example.fo",
      },
      capturedMessageCount: 2,
      capturedToolCallCount: 1,
      capturedNetworkRequestCount: 1,
      truncated: false,
    });
    // List rows never include the raw capture body.
    expect(report.content).toBeUndefined();
  });

  test("GET /api/reports?status= filters on the lifecycle status", async () => {
    await postReport(USER_TOKEN, VALID_REPORT);
    const reported = await app.fetch("/api/reports?status=reported", {
      headers: { "x-auth-token": ADMIN_TOKEN },
    });
    expect((await reported.json()).returned).toBe(1);
    const closed = await app.fetch("/api/reports?status=closed", {
      headers: { "x-auth-token": ADMIN_TOKEN },
    });
    expect((await closed.json()).returned).toBe(0);
  });

  test("GET /api/reports/:id returns the full capture for admins (AC3)", async () => {
    const submitted = await (await postReport(USER_TOKEN, VALID_REPORT)).json();

    const forbidden = await app.fetch(`/api/reports/${submitted.fragmentId}`, {
      headers: { "x-auth-token": USER_TOKEN },
    });
    expect(forbidden.status).toBe(403);

    const response = await app.fetch(`/api/reports/${submitted.fragmentId}`, {
      headers: { "x-auth-token": ADMIN_TOKEN },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id: submitted.fragmentId,
      status: "reported",
      sessionId: "conv_abc123",
    });
    expect(body.content).toContain("## Chat log");
    expect(body.content).toContain("show me herring catches");
  });

  test("GET /api/reports/:id for an unknown id is 404", async () => {
    const response = await app.fetch(
      "/api/reports/00000000-0000-0000-0000-000000000000",
      { headers: { "x-auth-token": ADMIN_TOKEN } },
    );
    expect(response.status).toBe(404);
  });

  test("a Usable outage surfaces as 502 on submit and 503 on list", async () => {
    // Force-close so the app's kept-alive connection can't keep serving.
    await usable.stop(true);
    try {
      const submit = await postReport(USER_TOKEN, VALID_REPORT);
      expect(submit.status).toBe(502);
      expect((await submit.json()).error).toBe("usable_write_failed");

      const list = await app.fetch("/api/reports", {
        headers: { "x-auth-token": ADMIN_TOKEN },
      });
      expect(list.status).toBe(503);
      expect((await list.json()).error).toBe("reports_unavailable");
    } finally {
      await usable.start();
    }
  });
});
