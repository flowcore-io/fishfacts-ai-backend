import type { MiddlewareHandler } from "hono";

export const ADMIN_AUTHORITY = "ADMIN" as const;

export function isAdmin(authorities: string[] | undefined | null): boolean {
  return Array.isArray(authorities) && authorities.includes(ADMIN_AUTHORITY);
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");
  if (!auth) {
    return c.json({ error: "missing_auth_token" }, 401);
  }
  if (!isAdmin(auth.user.authorities)) {
    return c.json({ error: "forbidden", reason: "admin_required" }, 403);
  }
  return next();
};
