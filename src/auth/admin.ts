import { API_ERROR, API_REASON } from "@/http/errors";
import type { MiddlewareHandler } from "hono";

export const ADMIN_AUTHORITY = "ADMIN" as const;

export function isAdmin(authorities: string[] | undefined | null): boolean {
  return Array.isArray(authorities) && authorities.includes(ADMIN_AUTHORITY);
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");
  if (!auth) {
    return c.json({ error: API_ERROR.missingAuthToken }, 401);
  }
  if (!isAdmin(auth.user.authorities)) {
    return c.json(
      { error: API_ERROR.forbidden, reason: API_REASON.adminRequired },
      403,
    );
  }
  return next();
};
