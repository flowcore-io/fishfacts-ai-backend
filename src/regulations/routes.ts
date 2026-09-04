import { randomUUID } from "node:crypto";
import { isAdmin, requireAdmin } from "@/auth/admin";
import { regulationAdminActionSchema } from "@/events/contracts";
import type { PathwayWriter } from "@/pathways";
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
  writer: PathwayWriter;
};

/**
 * The admin Regulations Inbox (stage ② B1 reads + B2 actions). ADMIN-gated
 * like /api/jobs — auth middleware is applied by app.ts on the
 * /api/regulations prefix, the admin check here. The action route mutates
 * nothing directly: it stamps and emits an event, and the projector is the
 * only writer of case state — so the audit trail can never disagree with
 * what actually happened.
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

  app.post("/cases/:id/actions", async (c) => {
    const auth = c.get("auth");
    // Service-layer re-check (belt & braces, per IDOR fragment).
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = regulationAdminActionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }
    const action = parsed.data;
    // Route-level, NOT a schema refine: the event schema also validates on
    // projection, and a future-only refine would reject a redelivered event
    // whose perfectly valid `until` has since passed.
    if (
      action.kind === "snooze" &&
      action.until !== null &&
      Date.parse(action.until) <= Date.now()
    ) {
      return c.json(
        { error: "invalid_payload", reason: "snooze_until_in_past" },
        400,
      );
    }
    let caseRef: Awaited<
      ReturnType<RegulationQueueReadRepository["getCaseRef"]>
    >;
    try {
      caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return c.json({ error: "not_found" }, 404);
      if (action.kind === "mark_duplicate") {
        if (action.duplicateOfCaseId.toLowerCase() === caseRef.id) {
          return c.json(
            { error: "invalid_payload", reason: "duplicate_of_self" },
            400,
          );
        }
        const target = await deps.queue.getCaseRef(
          action.duplicateOfCaseId.toLowerCase(),
        );
        if (!target) {
          return c.json(
            { error: "invalid_payload", reason: "duplicate_target_not_found" },
            400,
          );
        }
      }
    } catch (error) {
      console.error("[Regulations] action case lookup failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "queue_unavailable" }, 503);
    }
    try {
      const actionId = randomUUID();
      const recordedAt = new Date().toISOString();
      const eventId = await deps.writer.writeRegulationAdminActionRecorded({
        actionId,
        caseId: caseRef.id,
        caseKey: caseRef.caseKey,
        action,
        // Stamped from the authenticated admin + server clock, never from
        // the caller — the same posture as the POI write path.
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
      // 202: the event is durable; the projection catches up via the pump.
      return c.json({ actionId, eventId, recordedAt }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] action write failed", {
        caseId: id,
        kind: action.kind,
        message,
      });
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  return app;
}
