import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type { RegulationAdminActionRecorded } from "../../src/events/contracts";
import type { PathwayWriter } from "../../src/pathways";
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
const DUP_ID = "7c1de9a0-53f2-8b1c-9e4d-0a6b38c5d2e1";
const CASE_KEY = "test-source:test-ban";

const QUEUE_CASE = { id: CASE_ID, title: "Test ban" };
const DETAIL = {
  case: { id: CASE_ID, title: "Test ban" },
  revisions: [],
  sources: [],
  links: [],
};

function makeApp(opts: { error?: Error; writeError?: Error } = {}) {
  const calls: { listQueue: QueueListFilters[]; getCaseDetail: string[] } = {
    listQueue: [],
    getCaseDetail: [],
  };
  const written: RegulationAdminActionRecorded[] = [];
  const writer = {
    writeRegulationAdminActionRecorded: async (
      data: RegulationAdminActionRecorded,
    ) => {
      if (opts.writeError) throw opts.writeError;
      written.push(data);
      return "event-456";
    },
  } as unknown as PathwayWriter;
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
    getCaseRef: async (caseId: string) => {
      if (opts.error) throw opts.error;
      if (caseId === CASE_ID) return { id: CASE_ID, caseKey: CASE_KEY };
      if (caseId === DUP_ID) return { id: DUP_ID, caseKey: "test-source:dup" };
      return null;
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
  app.route(
    "/api/regulations",
    createRegulationsRouter({
      queue,
      writer,
      poi: { list: async () => [] } as never,
      jobRunner: {
        startJob: async () => ({ promise: Promise.resolve() }),
      } as never,
    }),
  );
  return { app, calls, written };
}

function postAction(
  app: Hono,
  body: unknown,
  opts: { id?: string; token?: string | null } = {},
) {
  return app.request(`/api/regulations/cases/${opts.id ?? CASE_ID}/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token === null
        ? {}
        : { "x-auth-token": opts.token ?? "admin-token" }),
    },
    body: JSON.stringify(body),
  });
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
    const action = { kind: "mark_read", read: true };
    expect((await postAction(app, action, { token: null })).status).toBe(401);
    expect(
      (await postAction(app, action, { token: "user-token" })).status,
    ).toBe(403);
  });
});

describe("POST /api/regulations/cases/:id/actions", () => {
  test("emits a stamped event and answers 202", async () => {
    const { app, written } = makeApp();
    const res = await postAction(app, { kind: "mark_read", read: true });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.eventId).toBe("event-456");
    expect(written).toHaveLength(1);
    const event = written[0];
    expect(event).toMatchObject({
      caseId: CASE_ID,
      caseKey: CASE_KEY,
      action: { kind: "mark_read", read: true },
      actor: "admin:gilli",
    });
    expect(event?.actionId).toBe(body.actionId);
    expect(Date.parse(event?.recordedAt ?? "")).not.toBeNaN();
  });

  test("every action kind validates through", async () => {
    const { app, written } = makeApp();
    const actions = [
      { kind: "assign", assignee: "gilli" },
      { kind: "assign", assignee: null },
      { kind: "set_urgency", urgency: "critical" },
      { kind: "snooze", until: new Date(Date.now() + 3600_000).toISOString() },
      { kind: "snooze", until: null },
      { kind: "request_information", note: "Which vessels does §2 cover?" },
      { kind: "reject", reason: "Not a regulation" },
      { kind: "mark_duplicate", duplicateOfCaseId: DUP_ID },
    ];
    for (const action of actions) {
      const res = await postAction(app, action);
      expect(res.status).toBe(202);
    }
    expect(written).toHaveLength(actions.length);
  });

  test("caller cannot forge actor or recordedAt", async () => {
    const { app, written } = makeApp();
    await postAction(app, {
      kind: "mark_read",
      read: true,
      actor: "admin:mallory",
      recordedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(written[0]?.actor).toBe("admin:gilli");
    expect(written[0]?.recordedAt).not.toBe("1970-01-01T00:00:00.000Z");
  });

  test("unknown action kind or bad payload is a 400", async () => {
    const { app } = makeApp();
    expect(
      (await postAction(app, { kind: "approve", revisionId: DUP_ID })).status,
    ).toBe(400);
    expect((await postAction(app, { kind: "reject" })).status).toBe(400);
    expect(
      (await postAction(app, { kind: "snooze", until: "tomorrow" })).status,
    ).toBe(400);
  });

  test("a snooze into the past is a 400, not a silent immediate wake", async () => {
    const { app, written } = makeApp();
    const res = await postAction(app, {
      kind: "snooze",
      until: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("snooze_until_in_past");
    expect(written).toHaveLength(0);
  });

  test("unknown case is a 404; malformed id never reaches the repo", async () => {
    const { app } = makeApp();
    const action = { kind: "mark_read", read: true };
    expect(
      (
        await postAction(app, action, {
          id: "00000000-0000-8000-8000-000000000000",
        })
      ).status,
    ).toBe(404);
    expect((await postAction(app, action, { id: "nope" })).status).toBe(404);
  });

  test("mark_duplicate refuses self and missing targets", async () => {
    const { app } = makeApp();
    const self = await postAction(app, {
      kind: "mark_duplicate",
      duplicateOfCaseId: CASE_ID,
    });
    expect(self.status).toBe(400);
    expect((await self.json()).reason).toBe("duplicate_of_self");
    const missing = await postAction(app, {
      kind: "mark_duplicate",
      duplicateOfCaseId: "00000000-0000-8000-8000-000000000000",
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).reason).toBe("duplicate_target_not_found");
  });

  test("a failed event write is a 502", async () => {
    const { app } = makeApp({ writeError: new Error("flowcore down") });
    const res = await postAction(app, { kind: "mark_read", read: true });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("flowcore_write_failed");
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
