import { randomUUID } from "node:crypto";
import { isAdmin, requireAdmin } from "@/auth/admin";
import {
  type RegulationRevisionChange,
  regulationAdminActionSchema,
  regulationRevisionFieldsSchema,
  regulationRevisionGeometrySchema,
} from "@/events/contracts";
import type { PathwayWriter } from "@/pathways";
import { Hono } from "hono";
import { z } from "zod";
import type { RegulationQueueReadRepository } from "./read-repository";
import { editableFieldsOfCase, fieldValueEquals } from "./revision-fields";
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

  // ---------------------------------------------------------------------
  // B3 — the revision loop. Same posture as the actions route: these
  // handlers stamp and emit events; the projector is the only writer.
  // NOTE for F4: approval (and B2's reject) must NEVER be registered as
  // parent tools on the admin embed — the agent proposes, the human decides.
  // That guarantee is structural in the FE tool registry, not a prompt.
  // ---------------------------------------------------------------------

  const revisionProposalSchema = z.object({
    baseRevisionId: z.string().uuid(),
    fields: regulationRevisionFieldsSchema,
    /** null/omitted = keep the base revision's areas. */
    geometries: z
      .array(regulationRevisionGeometrySchema)
      .nullable()
      .default(null),
    /** field → why it changed. Required for exactly the fields that differ. */
    justifications: z.record(z.string().min(1).max(2000)).default({}),
  });

  const pointerMoveSchema = z.object({ toRevisionId: z.string().uuid() });

  const validationRequestSchema = z
    .object({
      revisionId: z.string().uuid(),
      scope: z.enum(["legal", "geometry"]),
      geometryId: z.string().uuid().nullable().default(null),
      validated: z.boolean(),
      note: z.string().max(2000).nullable().default(null),
    })
    .refine(
      (value) =>
        value.scope === "geometry"
          ? value.geometryId !== null
          : value.geometryId === null,
      {
        message: "geometryId is required exactly when scope is geometry",
        path: ["geometryId"],
      },
    );

  const approvalRequestSchema = z.object({
    revisionId: z.string().uuid(),
    /** §12's publish-metadata-only path: legal validation alone suffices
     * when no geometry can be verified. Recorded on the approval. */
    metadataOnly: z.boolean().default(false),
    note: z.string().max(2000).nullable().default(null),
  });

  /** The 409 body a superseded revision id earns: who moved the draft and
   * why, so the reviewer re-reviews the delta instead of guessing. */
  async function staleRevisionBody(
    caseId: string,
    currentRevisionId: string,
    namedRevisionId: string,
  ) {
    const named = await deps.queue.getRevision(namedRevisionId);
    const revisionsSince = named
      ? await deps.queue.listRevisionsSince(caseId, named.position)
      : await deps.queue.listRevisionsSince(caseId, -1);
    return {
      error: "stale_revision",
      currentRevisionId,
      namedRevisionId,
      revisionsSince,
    };
  }

  app.post("/cases/:id/revisions", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = revisionProposalSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return c.json({ error: "not_found" }, 404);
      if (parsed.data.baseRevisionId !== caseRow.currentRevisionId) {
        return c.json(
          await staleRevisionBody(
            caseRow.id,
            caseRow.currentRevisionId,
            parsed.data.baseRevisionId,
          ),
          409,
        );
      }

      // Derive the change list server-side: the client sends the full draft,
      // the diff against the live case decides what changed, and every
      // change must arrive with its justification (§12).
      const baseFields = editableFieldsOfCase(caseRow);
      const changedFields = (
        Object.keys(baseFields) as Array<keyof typeof baseFields>
      ).filter(
        (key) =>
          !fieldValueEquals(
            parsed.data.fields[key] ?? null,
            baseFields[key] ?? null,
          ),
      );
      const changeKeys: string[] = [...changedFields];
      if (parsed.data.geometries !== null) changeKeys.push("geometries");
      if (changeKeys.length === 0) {
        return c.json({ error: "invalid_payload", reason: "no_changes" }, 400);
      }
      const missing = changeKeys.filter(
        (key) => !parsed.data.justifications[key],
      );
      if (missing.length > 0) {
        return c.json(
          {
            error: "invalid_payload",
            reason: "missing_justification",
            fields: missing,
          },
          400,
        );
      }
      const unexplained = Object.keys(parsed.data.justifications).filter(
        (key) => !changeKeys.includes(key),
      );
      if (unexplained.length > 0) {
        return c.json(
          {
            error: "invalid_payload",
            reason: "justification_for_unchanged_field",
            fields: unexplained,
          },
          400,
        );
      }

      // Materialize the full resulting area set so the event is
      // self-contained: untouched geometry is copied from the base.
      const geometries =
        parsed.data.geometries ??
        (await deps.queue.getRevisionGeometries(caseRow.currentRevisionId)).map(
          (row) => ({
            name: row.name,
            section: row.section,
            kind: row.kind as "closure" | "exemption" | "other",
            season: row.season,
            verticesQuoted: row.verticesQuoted as string[] | null,
            points: row.points as Array<{ lat: number; lon: number }>,
            geometrySource: row.geometrySource as
              | "enumerated"
              | "preparsed"
              | "described",
            coordinateSystem: row.coordinateSystem,
            precision: row.precision,
          }),
        );
      const changes: RegulationRevisionChange[] = changeKeys.map((field) => ({
        field: field as RegulationRevisionChange["field"],
        justification: parsed.data.justifications[field] as string,
      }));

      const revisionId = randomUUID();
      const recordedAt = new Date().toISOString();
      const eventId = await deps.writer.writeRegulationRevisionProposed({
        revisionId,
        caseId: caseRow.id,
        caseKey: caseRow.caseKey,
        baseRevisionId: parsed.data.baseRevisionId,
        changes,
        fields: parsed.data.fields,
        geometries,
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
      return c.json({ revisionId, eventId, recordedAt }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] revision proposal failed", {
        caseId: id,
        message,
      });
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  app.post("/cases/:id/revision-pointer", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = pointerMoveSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return c.json({ error: "not_found" }, 404);
      const target = await deps.queue.getRevision(parsed.data.toRevisionId);
      if (!target || target.caseId !== caseRef.id) {
        return c.json(
          { error: "invalid_payload", reason: "revision_not_of_case" },
          400,
        );
      }
      const pointerMoveId = randomUUID();
      const recordedAt = new Date().toISOString();
      const eventId = await deps.writer.writeRegulationRevisionPointerMoved({
        pointerMoveId,
        caseId: caseRef.id,
        caseKey: caseRef.caseKey,
        toRevisionId: target.id,
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
      return c.json({ pointerMoveId, eventId, recordedAt }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] pointer move failed", {
        caseId: id,
        message,
      });
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  app.post("/cases/:id/validations", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = validationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return c.json({ error: "not_found" }, 404);
      // Validating anything but the current revision is refused outright —
      // a validation of superseded text is not review, it is theatre.
      if (parsed.data.revisionId !== caseRow.currentRevisionId) {
        return c.json(
          await staleRevisionBody(
            caseRow.id,
            caseRow.currentRevisionId,
            parsed.data.revisionId,
          ),
          409,
        );
      }
      if (parsed.data.scope === "geometry" && parsed.data.geometryId) {
        const geometries = await deps.queue.getRevisionGeometries(
          parsed.data.revisionId,
        );
        if (!geometries.some((g) => g.id === parsed.data.geometryId)) {
          return c.json(
            { error: "invalid_payload", reason: "geometry_not_of_revision" },
            400,
          );
        }
      }
      const validationId = randomUUID();
      const recordedAt = new Date().toISOString();
      const eventId = await deps.writer.writeRegulationValidationRecorded({
        validationId,
        caseId: caseRow.id,
        caseKey: caseRow.caseKey,
        revisionId: parsed.data.revisionId,
        scope: parsed.data.scope,
        geometryId: parsed.data.geometryId,
        validated: parsed.data.validated,
        note: parsed.data.note,
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
      return c.json({ validationId, eventId, recordedAt }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] validation failed", {
        caseId: id,
        message,
      });
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  app.post("/cases/:id/approval", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = approvalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return c.json({ error: "not_found" }, 404);
      // The edit-after-review race, closed synchronously: an approval names
      // a revision, and a superseded one is refused WITH the diff. The
      // projector re-checks under stream order for the write in flight.
      if (parsed.data.revisionId !== caseRow.currentRevisionId) {
        return c.json(
          await staleRevisionBody(
            caseRow.id,
            caseRow.currentRevisionId,
            parsed.data.revisionId,
          ),
          409,
        );
      }
      const missing: string[] = [];
      if (!caseRow.regulatoryValidated) missing.push("legal");
      if (!parsed.data.metadataOnly && !caseRow.geometryValidated) {
        missing.push("geometry");
      }
      if (missing.length > 0) {
        return c.json({ error: "validation_missing", missing }, 422);
      }
      const approvalId = randomUUID();
      const recordedAt = new Date().toISOString();
      const eventId = await deps.writer.writeRegulationApprovalRecorded({
        approvalId,
        caseId: caseRow.id,
        caseKey: caseRow.caseKey,
        revisionId: parsed.data.revisionId,
        metadataOnly: parsed.data.metadataOnly,
        note: parsed.data.note,
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
      return c.json({ approvalId, eventId, recordedAt }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] approval failed", { caseId: id, message });
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  return app;
}
