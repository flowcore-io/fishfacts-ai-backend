import { isAdmin, requireAdmin } from "@/auth/admin";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { ZodError, z } from "zod";
import { REVIEW_REASONS, REVIEW_STATUSES } from "./review";
import type { LogasavnReviewRepository } from "./review-repository";
import { verdictInputSchema } from "./verdict";

const listQuerySchema = z.object({
  status: z.enum(REVIEW_STATUSES).optional(),
  reason: z.enum(REVIEW_REASONS).optional(),
  inForce: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(500).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});

export type LogasavnReviewRouterDeps = {
  repository: LogasavnReviewRepository;
  authMiddleware: MiddlewareHandler;
};

/**
 * The human half of the Lógasavn review queue.
 *
 * The sweep fills this table and can never write a verdict into it; this router
 * is the only thing that can, and it is ADMIN-only end to end — unlike
 * `/api/poi`, there is no public read here, because a pending row is an
 * unverified reading of the law and publishing it would be the very thing the
 * review step exists to prevent.
 *
 * Deliberately small and curl-shaped. The plan wants the reason enum validated
 * against real decisions BEFORE an admin UI commits to a shape, so this is that
 * instrument as much as it is the UI's eventual backend.
 */
export function createLogasavnReviewRouter(
  deps: LogasavnReviewRouterDeps,
): Hono {
  const app = new Hono();

  app.use("*", deps.authMiddleware, requireAdmin);

  app.get("/", async (c) => {
    let query: z.infer<typeof listQuerySchema>;
    try {
      query = listQuerySchema.parse(
        Object.fromEntries(new URL(c.req.url).searchParams),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_query", issues: error.issues }, 400);
      }
      return c.json({ error: "invalid_query" }, 400);
    }
    try {
      const [rows, summary] = await Promise.all([
        deps.repository.listForReview({
          status: query.status,
          reason: query.reason,
          inForceOnly: query.inForce,
          limit: query.limit,
          offset: query.offset,
        }),
        deps.repository.summarise(),
      ]);
      // The summary is returned alongside every page so a reviewer paging
      // through 304 rows can always see how much is left and what kind it is,
      // without a second call and without inferring it from the page.
      return c.json({ rows, returned: rows.length, summary });
    } catch (error) {
      console.error("[LogasavnReview] list failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "review_queue_unavailable" }, 503);
    }
  });

  app.patch("/:fragmentId/:contentHash", async (c) => {
    const auth = c.get("auth");
    // Service-layer re-check alongside the middleware (belt & braces, per the
    // IDOR precedent on the POI write path).
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    let input: z.infer<typeof verdictInputSchema>;
    try {
      input = verdictInputSchema.parse(await c.req.json());
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_payload", issues: error.issues }, 400);
      }
      return c.json({ error: "invalid_payload" }, 400);
    }

    try {
      const result = await deps.repository.recordVerdict({
        fragmentId: c.req.param("fragmentId"),
        contentHash: c.req.param("contentHash"),
        status: input.status,
        declineReason: input.declineReason ?? null,
        recurrence: input.recurrence ?? null,
        // Stamped from the authenticated admin, never taken from the body, so
        // a verdict cannot be attributed to someone who did not make it.
        reviewedBy: auth.user.username,
      });
      if (result.outcome === "recorded") return c.json({ row: result.row });
      if (result.outcome === "stale") {
        // 409, not 404: the statute IS in the queue, but its text moved after
        // the reviewer read it. Handing back the current hash lets them re-read
        // and decide again rather than guess why the write bounced.
        return c.json(
          {
            error: "stale_content_hash",
            reason:
              "the statute was re-scraped after you read it; re-read the current text and decide again",
            currentHash: result.currentHash,
          },
          409,
        );
      }
      return c.json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("[LogasavnReview] verdict failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "verdict_write_failed" }, 503);
    }
  });

  return app;
}
