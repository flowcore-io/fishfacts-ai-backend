import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type {
  QueueListFilters,
  RegulationQueueReadRepository,
} from "../../src/regulations/read-repository";
import { createRegulationsRouter } from "../../src/regulations/routes";

function userOf(username: string, authorities: string[]): AuthContext {
  return {
    token: "t",
    user: {
      id: 1,
      username,
      firstName: "Test",
      lastName: "User",
      groupId: 1,
      groupName: null,
      authorities,
      fleets: [],
      serviceProvidersId: [],
      newsId: [],
      eventsId: [],
    },
  };
}

/** Stands in for createAuthMiddleware: token → auth context, or 401. */
const TOKENS: Record<string, AuthContext> = {
  "admin-token": userOf("gilli", ["ADMIN", "USER"]),
  "user-token": userOf("deckhand", ["USER"]),
};

const CASE_ID = "b52ba6c8-2ee0-8f9a-8bd7-6a4d29e0f7c3";

const QUEUE_CASE = { id: CASE_ID, title: "Test ban" };
const DETAIL = {
  case: { id: CASE_ID, title: "Test ban" },
  revisions: [],
  sources: [],
  links: [],
};

function makeApp(opts: { error?: Error } = {}) {
  const calls: { listQueue: QueueListFilters[]; getCaseDetail: string[] } = {
    listQueue: [],
    getCaseDetail: [],
  };
  const queue = {
    listQueue: async (filters: QueueListFilters) => {
      if (opts.error) throw opts.error;
      calls.listQueue.push(filters);
      return { cases: [QUEUE_CASE], total: 1 };
    },
    counts: async () => {
      if (opts.error) throw opts.error;
      return { unread: 7, snoozed: 2, byAdminStatus: { unread: 7 } };
    },
    getCaseDetail: async (caseId: string) => {
      if (opts.error) throw opts.error;
      calls.getCaseDetail.push(caseId);
      return caseId === CASE_ID ? DETAIL : null;
    },
  } as unknown as RegulationQueueReadRepository;
  const app = new Hono();
  // app.ts blankets the prefix with the auth middleware; mirror that here.
  app.use("/api/regulations/*", async (c, next) => {
    const auth = TOKENS[c.req.header("x-auth-token") ?? ""];
    if (!auth) return c.json({ error: "missing_auth_token" }, 401);
    c.set("auth", auth);
    return next();
  });
  app.route("/api/regulations", createRegulationsRouter({ queue }));
  return { app, calls };
}

function get(app: Hono, path: string, token: string | null = "admin-token") {
  return app.request(`/api/regulations${path}`, {
    headers: token ? { "x-auth-token": token } : {},
  });
}

describe("regulations router auth", () => {
  test("no token → 401, non-admin → 403, on every route", async () => {
    const { app } = makeApp();
    for (const path of ["/queue", "/queue/counts", `/cases/${CASE_ID}`]) {
      expect((await get(app, path, null)).status).toBe(401);
      expect((await get(app, path, "user-token")).status).toBe(403);
    }
  });
});

describe("GET /api/regulations/queue", () => {
  test("defaults: no filters, limit 50, offset 0, snoozed hidden", async () => {
    const { app, calls } = makeApp();
    const res = await get(app, "/queue");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      returned: 1,
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(calls.listQueue[0]).toMatchObject({ limit: 50, offset: 0 });
    expect(calls.listQueue[0]?.adminStatus).toBeUndefined();
    expect(calls.listQueue[0]?.includeSnoozed).toBeUndefined();
  });

  test("filters parse through: comma lists, booleans, pagination", async () => {
    const { app, calls } = makeApp();
    const res = await get(
      app,
      "/queue?status=unread,under_review&jurisdiction=FO,NO&urgency=high" +
        "&assignee=gilli&unread=true&includeSnoozed=true&limit=10&offset=20",
    );
    expect(res.status).toBe(200);
    expect(calls.listQueue[0]).toEqual({
      adminStatus: ["unread", "under_review"],
      jurisdiction: ["FO", "NO"],
      urgency: ["high"],
      assignee: "gilli",
      unread: true,
      includeSnoozed: true,
      limit: 10,
      offset: 20,
    });
  });

  test("a typo'd status is a 400, not a silently empty inbox", async () => {
    const { app } = makeApp();
    const res = await get(app, "/queue?status=unraed");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_query");
  });

  test("limit above the cap is a 400", async () => {
    const { app } = makeApp();
    expect((await get(app, "/queue?limit=201")).status).toBe(400);
  });

  test("repository failure is a 503, not a crash", async () => {
    const { app } = makeApp({ error: new Error("db down") });
    const res = await get(app, "/queue");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("queue_unavailable");
  });
});

describe("GET /api/regulations/queue/counts", () => {
  test("returns the badge numbers", async () => {
    const { app } = makeApp();
    const res = await get(app, "/queue/counts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      unread: 7,
      snoozed: 2,
      byAdminStatus: { unread: 7 },
    });
  });
});

describe("GET /api/regulations/cases/:id", () => {
  test("returns the full detail for a known case", async () => {
    const { app } = makeApp();
    const res = await get(app, `/cases/${CASE_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DETAIL);
  });

  test("uppercase id reaches the repository lowercased", async () => {
    const { app, calls } = makeApp();
    await get(app, `/cases/${CASE_ID.toUpperCase()}`);
    expect(calls.getCaseDetail).toEqual([CASE_ID]);
  });

  test("a non-UUID id is a 404 before the database", async () => {
    const { app, calls } = makeApp();
    const res = await get(app, "/cases/not-a-uuid");
    expect(res.status).toBe(404);
    expect(calls.getCaseDetail).toHaveLength(0);
  });

  test("an unknown case id is a 404", async () => {
    const { app } = makeApp();
    const res = await get(app, "/cases/00000000-0000-8000-8000-000000000000");
    expect(res.status).toBe(404);
  });
});
