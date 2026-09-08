import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type {
  PublishedListFilters,
  PublishedRegulation,
  RegulationPublishedReadRepository,
} from "../../src/regulations/published-repository";
import { createPublishedRegulationsRouter } from "../../src/regulations/published-routes";
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

const TOKENS: Record<string, AuthContext> = {
  "admin-token": userOf("gilli", ["ADMIN", "USER"]),
  "user-token": userOf("deckhand", ["USER"]),
};

const CASE_ID = "b52ba6c8-2ee0-8f9a-8bd7-6a4d29e0f7c3";

const PUBLISHED = {
  id: CASE_ID,
  caseKey: "test-source:test-ban",
  title: "Test ban",
  inForce: "current",
  geometries: [],
} as unknown as PublishedRegulation;

/** Mirrors app.ts exactly: blanket auth on the prefix, the published router
 * mounted BEFORE the admin router — the mounting order IS the security
 * property this file pins. */
function makeApp(opts: { error?: Error } = {}) {
  const calls: { list: PublishedListFilters[]; get: string[] } = {
    list: [],
    get: [],
  };
  const published = {
    listPublished: async (filters: PublishedListFilters) => {
      if (opts.error) throw opts.error;
      calls.list.push(filters);
      return { regulations: [PUBLISHED], total: 1 };
    },
    getPublished: async (caseId: string) => {
      if (opts.error) throw opts.error;
      calls.get.push(caseId);
      return caseId === CASE_ID ? PUBLISHED : null;
    },
  } as unknown as RegulationPublishedReadRepository;
  const app = new Hono();
  app.use("/api/regulations/*", async (c, next) => {
    const auth = TOKENS[c.req.header("x-auth-token") ?? ""];
    if (!auth) return c.json({ error: "missing_auth_token" }, 401);
    c.set("auth", auth);
    return next();
  });
  app.route(
    "/api/regulations/published",
    createPublishedRegulationsRouter({ published }),
  );
  app.route(
    "/api/regulations",
    createRegulationsRouter({
      queue: {
        listQueue: async () => ({ cases: [], total: 0 }),
      } as never,
      writer: {} as never,
      poi: { list: async () => [] } as never,
      jobRunner: { startJob: async () => ({ promise: Promise.resolve() }) } as never,
    }),
  );
  return { app, calls };
}

function get(app: Hono, path: string, token: string | null = "user-token") {
  return app.request(path, {
    headers: token === null ? {} : { "x-auth-token": token },
  });
}

describe("published regulations routes", () => {
  test("a plain USER reads the published list and detail — no ADMIN required", async () => {
    const { app, calls } = makeApp();
    const list = await get(app, "/api/regulations/published");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { regulations: unknown[]; total: number };
    expect(body.regulations).toHaveLength(1);
    expect(body.total).toBe(1);
    // The window filter defaults to in-force-now for map/tool consumers.
    expect(calls.list[0]?.status).toBe("current");

    const detail = await get(app, `/api/regulations/published/${CASE_ID}`);
    expect(detail.status).toBe(200);
    expect(calls.get[0]).toBe(CASE_ID);
  });

  test("the same USER token is still refused by the admin queue next door", async () => {
    const { app } = makeApp();
    const queue = await get(app, "/api/regulations/queue");
    expect(queue.status).toBe(403);
  });

  test("unauthenticated requests get 401 from the blanket middleware", async () => {
    const { app } = makeApp();
    const response = await get(app, "/api/regulations/published", null);
    expect(response.status).toBe(401);
  });

  test("query validation and filter passthrough", async () => {
    const { app, calls } = makeApp();
    const ok = await get(
      app,
      "/api/regulations/published?jurisdiction=FO,NO&status=all&limit=5&offset=10",
    );
    expect(ok.status).toBe(200);
    expect(calls.list[0]).toEqual({
      jurisdiction: ["FO", "NO"],
      status: "all",
      limit: 5,
      offset: 10,
    });

    const bad = await get(app, "/api/regulations/published?status=nope");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "invalid_query",
    );
  });

  test("an unpublished or malformed id is a plain 404 — the queue's existence never leaks", async () => {
    const { app } = makeApp();
    const unknown = await get(
      app,
      "/api/regulations/published/7c1de9a0-53f2-8b1c-9e4d-0a6b38c5d2e1",
    );
    expect(unknown.status).toBe(404);
    const malformed = await get(app, "/api/regulations/published/not-a-uuid");
    expect(malformed.status).toBe(404);
  });

  test("a repository failure answers 503 published_unavailable", async () => {
    const { app } = makeApp({ error: new Error("boom") });
    const response = await get(app, "/api/regulations/published");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
      "published_unavailable",
    );
  });
});
