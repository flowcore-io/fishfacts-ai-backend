import type { TokenCache } from "@/auth/cache";
import type { FishfactsApiClient } from "@/fishfacts/client";
import type { MiddlewareHandler } from "hono";

const TILE_PATH_RE = /^\/api\/tiles\/.+\.pbf$/;

export function createAuthMiddleware(
  client: FishfactsApiClient,
  cache: TokenCache,
): MiddlewareHandler {
  return async (c, next) => {
    const headerToken = c.req.header("x-auth-token")?.trim();
    const allowQueryToken = TILE_PATH_RE.test(new URL(c.req.url).pathname);
    const queryToken = allowQueryToken
      ? c.req.query("token")?.trim()
      : undefined;
    const token = headerToken || queryToken;
    if (!token) {
      return c.json({ error: "missing_auth_token" }, 401);
    }

    const cached = cache.get(token);
    if (cached) {
      c.set("auth", cached);
      return next();
    }

    const result = await client.validateToken(token);
    if (!result.ok) {
      if (result.reason === "invalid_token") {
        return c.json({ error: "invalid_auth_token" }, 401);
      }
      if (result.reason === "invalid_response") {
        return c.json({ error: "auth_upstream_invalid_response" }, 502);
      }
      return c.json({ error: "auth_upstream_unavailable" }, 502);
    }

    const auth = { token, user: result.user };
    cache.set(token, auth);
    c.set("auth", auth);
    return next();
  };
}
