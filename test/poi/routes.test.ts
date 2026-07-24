import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type { PoiCreated } from "../../src/events/contracts";
import type { PathwayWriter } from "../../src/pathways";
import type { PoiRepository } from "../../src/poi/repository";
import { createPoiRouter } from "../../src/poi/routes";

const GAZETTEER = [
  { key: "hanstholm_fyr", lat: 57.11269, lng: 8.59861, title: "Hanstholm fyr" },
];

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

function makeApp(opts: { writeError?: Error } = {}) {
  const written: PoiCreated[] = [];
  const writer = {
    writePoiCreated: async (data: PoiCreated) => {
      if (opts.writeError) throw opts.writeError;
      written.push(data);
      return "event-123";
    },
  } as unknown as PathwayWriter;
  const repository = {
    list: async () => GAZETTEER,
  } as unknown as PoiRepository;
  const app = new Hono();
  app.route(
    "/api/poi",
    createPoiRouter({
      repository,
      writer,
      authMiddleware: async (c, next) => {
        const auth = TOKENS[c.req.header("x-auth-token") ?? ""];
        if (!auth) return c.json({ error: "missing_auth_token" }, 401);
        c.set("auth", auth);
        return next();
      },
    }),
  );
  return { app, written };
}

function post(app: Hono, token: string | null, body: unknown) {
  return app.request("/api/poi", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-auth-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  key: "skarvenes_lykt",
  title: "Skarvenes lykt (minor light, Finnmark)",
  lat: 70.9012,
  lng: 26.7345,
  aliases: ["Skarvenes light"],
  source: "NGA List of Lights 115-5678",
};

describe("POI routes", () => {
  test("GET / stays public — no token required", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/poi");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pois: GAZETTEER, returned: 1 });
  });

  test("POST without a token is rejected before reaching the writer", async () => {
    const { app, written } = makeApp();
    const res = await post(app, null, VALID_BODY);
    expect(res.status).toBe(401);
    expect(written).toHaveLength(0);
  });

  test("POST as non-admin → 403 admin_required, nothing written (AC2)", async () => {
    const { app, written } = makeApp();
    const res = await post(app, "user-token", VALID_BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      reason: "admin_required",
    });
    expect(written).toHaveLength(0);
  });

  test("POST as admin emits the event with server-stamped attribution", async () => {
    const { app, written } = makeApp();
    const res = await post(app, "admin-token", VALID_BODY);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ key: "skarvenes_lykt", eventId: "event-123" });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      ...VALID_BODY,
      verifiedBy: "gilli",
      verifiedAt: body.verifiedAt,
    });
    expect(new Date(written[0].verifiedAt).toISOString()).toBe(
      written[0].verifiedAt,
    );
  });

  test("caller-supplied verifiedBy/verifiedAt are ignored — attribution cannot be forged", async () => {
    const { app, written } = makeApp();
    const res = await post(app, "admin-token", {
      ...VALID_BODY,
      verifiedBy: "the-pope",
      verifiedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(202);
    expect(written[0].verifiedBy).toBe("gilli");
    expect(written[0].verifiedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  test.each([
    ["bad key casing", { ...VALID_BODY, key: "Skarvenes-Lykt" }],
    ["lat out of range", { ...VALID_BODY, lat: 91 }],
    ["lng out of range", { ...VALID_BODY, lng: -181 }],
    ["missing source", { ...VALID_BODY, source: undefined }],
    ["missing title", { ...VALID_BODY, title: "" }],
  ])("POST with %s → 400, nothing written", async (_label, body) => {
    const { app, written } = makeApp();
    const res = await post(app, "admin-token", body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_payload");
    expect(written).toHaveLength(0);
  });

  test("a Flowcore write failure surfaces as 502", async () => {
    const { app } = makeApp({ writeError: new Error("webhook down") });
    const res = await post(app, "admin-token", VALID_BODY);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("flowcore_write_failed");
  });
});
