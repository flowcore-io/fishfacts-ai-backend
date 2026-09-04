import { requireAdmin } from "@/auth/admin";
import { Hono } from "hono";
import { z } from "zod";
import type { RegulationQueueReadRepository } from "./read-repository";
import { ADMIN_STATUSES } from "./status";

/** Case ids are deterministic UUIDs (`ids.ts`); anything else is a miss
 * before it reaches the database. */
const CASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?status=unread,under_review` → validated list; a typo'd status is a 400,
 * not a silently empty inbox. */
const commaList = (values: readonly string[] | null) =>
  z
    .string()
    .transform((value) => value.split(",").filter((entry) => entry.length > 0))
    .pipe(
      values
        ? z.array(z.enum(values as [string, ...string[]]))
        : z.array(z.string()),
    )
    .optional();

const booleanParam = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const queueQuerySchema = z.object({
  status: commaList(ADMIN_STATUSES),
  jurisdiction: commaList(null),
  // The urgency vocabulary is written by B2; the filter passes values through
  // rather than guessing the enum ahead of the write side.
  urgency: commaList(null),
  assignee: z.string().min(1).optional(),
  unread: booleanParam,
  includeSnoozed: booleanParam,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type RegulationsRouterDeps = {
  queue: RegulationQueueReadRepository;
};

/**
 * Read side of the admin Regulations Inbox (stage ② B1). ADMIN-gated like
 * /api/jobs — auth middleware is applied by app.ts on the /api/regulations
 * prefix, the admin check here. Deliberately read-only: every case mutation
 * is an event with a projector (B2/B3), so this router will never grow a
 * write handler.
 */
export function createRegulationsRouter(deps: RegulationsRouterDeps): Hono {
  const app = new Hono();
  app.use("*", requireAdmin);

  app.get("/queue", async (c) => {
    const parsed = queueQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: "invalid_query", issues: parsed.error.issues },
        400,
      );
    }
    const { status, ...rest } = parsed.data;
    try {
      const { cases, total } = await deps.queue.listQueue({
        adminStatus: status,
        ...rest,
      });
      return c.json({
        cases,
        returned: cases.length,
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    } catch (error) {
      console.error("[Regulations] queue list failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "queue_unavailable" }, 503);
    }
  });

  app.get("/queue/counts", async (c) => {
    try {
      return c.json(await deps.queue.counts());
    } catch (error) {
      console.error("[Regulations] queue counts failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "queue_unavailable" }, 503);
    }
  });

  app.get("/cases/:id", async (c) => {
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const detail = await deps.queue.getCaseDetail(id.toLowerCase());
      if (!detail) return c.json({ error: "not_found" }, 404);
      return c.json(detail);
    } catch (error) {
      console.error("[Regulations] case detail failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "queue_unavailable" }, 503);
    }
  });

  return app;
}
