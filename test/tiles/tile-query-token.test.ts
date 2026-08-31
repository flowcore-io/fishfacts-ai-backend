import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { TokenCache } from "../../src/auth/cache";
import { createAuthMiddleware } from "../../src/auth/middleware";
import type { FishfactsApiClient } from "../../src/fishfacts/client";

const VALID = "valid-token";

const client = {
  validateToken: async (token: string) =>
    token === VALID
      ? {
          ok: true as const,
          user: {
            id: 1,
            username: "deckhand",
            firstName: "Test",
            lastName: "User",
            groupId: 1,
            groupName: null,
            authorities: ["USER"],
            fleets: [],
            serviceProvidersId: [],
            newsId: [],
            eventsId: [],
          },
        }
      : { ok: false as const, reason: "invalid_token" as const },
} as unknown as FishfactsApiClient;

function makeApp() {
  const app = new Hono();
  app.use("/api/tiles/*", createAuthMiddleware(client, new TokenCache(60_000)));
  app.get("/api/tiles/*", (c) => c.text("ok"));
  return app;
}

// A mapbox raster source fetches tiles itself and sends none of our headers, so
// tile URLs — and only tile URLs — accept the token in the query string.
describe("tile query-string auth", () => {
  test("accepts a query token on a webp tile", async () => {
    const res = await makeApp().request(
      `/api/tiles/historic-charts-559/10/525/301.webp?token=${VALID}`,
    );
    expect(res.status).toBe(200);
  });

  test("still accepts a query token on a pbf tile", async () => {
    const res = await makeApp().request(
      `/api/tiles/jmelding-closures/5/1/1.pbf?token=${VALID}`,
    );
    expect(res.status).toBe(200);
  });

  test("rejects a bad query token on a webp tile", async () => {
    const res = await makeApp().request(
      "/api/tiles/historic-charts-559/10/525/301.webp?token=nope",
    );
    expect(res.status).toBe(401);
  });

  test("does not extend query-token auth to non-tile paths", async () => {
    const res = await makeApp().request(`/api/tiles/catalog?token=${VALID}`);
    expect(res.status).toBe(401);
  });

  test("header auth still works for webp tiles", async () => {
    const res = await makeApp().request(
      "/api/tiles/historic-charts-559/10/525/301.webp",
      { headers: { "x-auth-token": VALID } },
    );
    expect(res.status).toBe(200);
  });
});
