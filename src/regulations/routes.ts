import { randomUUID } from "node:crypto";
import { isAdmin, requireAdmin } from "@/auth/admin";
import {
  type RegulationRevisionChange,
  regulationAdminActionSchema,
  regulationGroupNameSchema,
  regulationRevisionFieldsSchema,
  regulationRevisionGeometrySchema,
} from "@/events/contracts";
import type { RegulationRevisionGeometry } from "@/events/contracts";
import {
  API_ERROR,
  API_REASON,
  errorResponse,
  flowcoreWriteFailed,
  forbiddenAdminRequired,
  groupNameTaken,
  invalidPayload,
  invalidQuery,
  notFound,
  serviceUnavailable,
} from "@/http/errors";
import { parseJmeldingGeo } from "@/jmelding/geo-parser";
import { JobAlreadyRunningError, type JobRunner } from "@/jobs/runner";
import type { PathwayWriter } from "@/pathways";
import type { PoiRepository } from "@/poi/repository";
import { Hono } from "hono";
import { z } from "zod";
import { type RegulationGroupRepository, groupDto } from "./group-repository";
import type { RegulationQueueReadRepository } from "./read-repository";
import {
  editableFieldsOfCase,
  fieldValueEquals,
  snapshotOnlyFieldsOf,
} from "./revision-fields";
import { ADMIN_STATUSES } from "./status";

/** Case ids are deterministic UUIDs (`ids.ts`); anything else is a miss
 * before it reaches the database. Shared with the published (non-admin)
 * router. */
export const CASE_ID =
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
  /** The admin-defined navigation groups — read side only; the group
   * projector is the sole writer. */
  groups: RegulationGroupRepository;
  writer: PathwayWriter;
  /** B4 agent-tool deps: the POI gazetteer behind resolve_landmark and the
   * job runner behind verdict recompute. */
  poi: PoiRepository;
  jobRunner: Pick<JobRunner, "startJob">;
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
      return invalidQuery(c, { issues: parsed.error.issues });
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
      return serviceUnavailable(c, API_ERROR.queueUnavailable);
    }
  });

  app.get("/queue/counts", async (c) => {
    try {
      return c.json(await deps.queue.counts());
    } catch (error) {
      console.error("[Regulations] queue counts failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.queueUnavailable);
    }
  });

  app.get("/cases/:id", async (c) => {
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    try {
      const detail = await deps.queue.getCaseDetail(id.toLowerCase());
      if (!detail) return notFound(c);
      return c.json(detail);
    } catch (error) {
      console.error("[Regulations] case detail failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.queueUnavailable);
    }
  });

  app.post("/cases/:id/actions", async (c) => {
    const auth = c.get("auth");
    // Service-layer re-check (belt & braces, per IDOR fragment).
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = regulationAdminActionSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
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
      return invalidPayload(c, { reason: API_REASON.snoozeUntilInPast });
    }
    let caseRef: Awaited<
      ReturnType<RegulationQueueReadRepository["getCaseRef"]>
    >;
    try {
      caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return notFound(c);
      if (action.kind === "mark_duplicate") {
        if (action.duplicateOfCaseId.toLowerCase() === caseRef.id) {
          return invalidPayload(c, { reason: API_REASON.duplicateOfSelf });
        }
        const target = await deps.queue.getCaseRef(
          action.duplicateOfCaseId.toLowerCase(),
        );
        if (!target) {
          return invalidPayload(c, {
            reason: API_REASON.duplicateTargetNotFound,
          });
        }
      }
    } catch (error) {
      console.error("[Regulations] action case lookup failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.queueUnavailable);
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
      return flowcoreWriteFailed(c, message);
    }
  });

  /**
   * A private admin working note on a case. Deliberately NOT an admin
   * action: a note decides nothing, so it must not appear in the audit
   * trail the case's state is read from, and it never enters a revision's
   * `fields` — which is what keeps it out of the published read, the corpus
   * fragment and the 1st mate by construction rather than by a filter.
   *
   * Append-only: there is no update or delete verb here, and that absence
   * IS the guarantee. A correction is a second note.
   */
  const caseNoteSchema = z.object({
    text: z.string().trim().min(1).max(4000),
  });

  app.post("/cases/:id/notes", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = caseNoteSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { reason: API_REASON.noteTextRequired });
    }
    let caseRef: Awaited<
      ReturnType<RegulationQueueReadRepository["getCaseRef"]>
    >;
    try {
      caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return notFound(c);
    } catch (error) {
      console.error("[Regulations] note case lookup failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.queueUnavailable);
    }
    const noteId = randomUUID();
    const recordedAt = new Date().toISOString();
    let eventId: string;
    try {
      eventId = await deps.writer.writeRegulationCaseNoteRecorded({
        noteId,
        caseId: caseRef.id,
        caseKey: caseRef.caseKey,
        text: parsed.data.text,
        // Stamped from the authenticated admin + server clock, never from
        // the caller — the same posture as every other write here.
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] note write failed", {
        caseId: id,
        message,
      });
      return flowcoreWriteFailed(c, message);
    }
    // Past this line the note IS recorded, so nothing below may answer with
    // a failure: `noteId` is minted per request, so a client that retries a
    // 502 would write the note twice. The read-back is a courtesy — it turns
    // the response into the real resource — and its own failure mode is the
    // same as a projection that has not landed yet.
    try {
      // The awaited write above waited (boundedly) for the note handler on
      // whichever replica ran it, so the row is normally there: answer with
      // the real row, not an optimistic echo of the request.
      const note = await deps.queue.getCaseNote(noteId);
      if (note) return c.json({ note }, 201);
    } catch (error) {
      console.error(
        "[Regulations] note read-back failed after a durable write",
        {
          caseId: id,
          noteId,
          message: error instanceof Error ? error.message : String(error),
        },
      );
    }
    // The event is durable and only its projection is unconfirmed — reported
    // as such rather than dressed up as a created resource or as a failure.
    return c.json(
      { noteId, eventId, recordedAt, status: "processing" as const },
      202,
    );
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
      error: API_ERROR.staleRevision,
      currentRevisionId,
      namedRevisionId,
      revisionsSince,
    };
  }

  app.post("/cases/:id/revisions", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = revisionProposalSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return notFound(c);
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
      // change must arrive with its justification (§12). Snapshot-only
      // fields (`displayName`) have no case column, so the base for those
      // comes from the current revision's own snapshot.
      const currentRevision = await deps.queue.getRevision(
        caseRow.currentRevisionId,
      );
      const baseFields = editableFieldsOfCase(
        caseRow,
        snapshotOnlyFieldsOf(currentRevision?.fields),
      );
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
        return invalidPayload(c, { reason: API_REASON.noChanges });
      }
      const missing = changeKeys.filter(
        (key) => !parsed.data.justifications[key],
      );
      if (missing.length > 0) {
        return invalidPayload(c, {
          reason: API_REASON.missingJustification,
          fields: missing,
        });
      }
      const unexplained = Object.keys(parsed.data.justifications).filter(
        (key) => !changeKeys.includes(key),
      );
      if (unexplained.length > 0) {
        return invalidPayload(c, {
          reason: API_REASON.justificationForUnchangedField,
          fields: unexplained,
        });
      }

      // A group is a real entity, so a proposal naming one must name a
      // usable one: the published read falls back to the country default
      // for a group that does not exist or has been retired, and an admin
      // who picked a group deserves to be told rather than to discover the
      // fallback after approval. Checked only when the group actually
      // moved, so a redraft of an unrelated field never fails on a group
      // retired since.
      // Already lower-cased by the field schema, so this lookup, the stored
      // snapshot and the published read all see the same id.
      const proposedGroupId = parsed.data.fields.groupId ?? null;
      if (proposedGroupId !== null && changedFields.includes("groupId")) {
        const group = await deps.groups.getById(proposedGroupId);
        if (!group) {
          return invalidPayload(c, { reason: API_REASON.groupNotFound });
        }
        if (group.jurisdiction !== caseRow.jurisdiction) {
          return invalidPayload(c, {
            reason: API_REASON.groupNotOfJurisdiction,
          });
        }
        if (group.retiredAt) {
          return invalidPayload(c, { reason: API_REASON.groupRetired });
        }
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
      return flowcoreWriteFailed(c, message);
    }
  });

  app.post("/cases/:id/revision-pointer", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = pointerMoveSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    try {
      const caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return notFound(c);
      const target = await deps.queue.getRevision(parsed.data.toRevisionId);
      if (!target || target.caseId !== caseRef.id) {
        return invalidPayload(c, { reason: API_REASON.revisionNotOfCase });
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
      return flowcoreWriteFailed(c, message);
    }
  });

  app.post("/cases/:id/validations", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = validationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return notFound(c);
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
          return invalidPayload(c, {
            reason: API_REASON.geometryNotOfRevision,
          });
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
      return flowcoreWriteFailed(c, message);
    }
  });

  app.post("/cases/:id/approval", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = approvalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return notFound(c);
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
        return errorResponse(c, 422, API_ERROR.validationMissing, {
          missing,
        });
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
      return flowcoreWriteFailed(c, message);
    }
  });

  // ---------------------------------------------------------------------
  // B4 — admin agent tool endpoints. These ARE meant to become parent
  // tools on the admin embed (unlike approval/reject): they investigate
  // and propose, they never validate, approve or publish.
  // ---------------------------------------------------------------------

  /** Faroese/Norwegian names carry diacritics inconsistently across
   * sources; both sides normalise before matching. */
  const normalizeName = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/ø/g, "o")
      .replace(/æ/g, "ae")
      .replace(/ð/g, "d");

  app.get("/landmarks", async (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (q.length < 2) {
      return invalidQuery(c, { reason: API_REASON.qTooShort });
    }
    try {
      const needle = normalizeName(q);
      const matches = (await deps.poi.list()).filter((poi) =>
        [poi.key.replace(/_/g, " "), poi.title ?? "", ...(poi.aliases ?? [])]
          .map(normalizeName)
          // A titleless POI would contribute "" here, and
          // `needle.includes("")` is true for every needle — silent noise
          // in every lookup.
          .filter((name) => name.length > 0)
          .some((name) => name.includes(needle) || needle.includes(name)),
      );
      return c.json({ matches, returned: matches.length });
    } catch (error) {
      console.error("[Regulations] landmark lookup failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.poiUnavailable);
    }
  });

  app.post("/cases/:id/reverdict", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    try {
      const caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return notFound(c);
      // The existing re-judge path: naming a caseKey replaces the pending
      // filter, so the CURRENT revision is re-judged regardless of its
      // verdict state, through the same embed → event → projection pipe.
      const started = await deps.jobRunner.startJob(
        "regulation-verdict",
        "manual",
        {
          caseKeys: [caseRef.caseKey],
          limit: 1,
        },
      );
      void started.promise.catch((error: unknown) => {
        console.error("[Regulations] reverdict run failed", {
          caseKey: caseRef.caseKey,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return c.json(
        {
          ok: true,
          caseKey: caseRef.caseKey,
          jobId: "regulation-verdict",
          runId: started.runId,
        },
        202,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof JobAlreadyRunningError) {
        return errorResponse(c, 409, API_ERROR.verdictJobRunning);
      }
      console.error("[Regulations] reverdict failed", { caseId: id, message });
      return errorResponse(c, 502, API_ERROR.reverdictFailed, {
        message,
      });
    }
  });

  /**
   * Run the applicability extraction for ONE case — the admin-chat affordance
   * behind "read who this applies to". Mirrors /reverdict: the job is the only
   * thing that talks to the model, and it proposes a revision an admin still
   * has to confirm. Naming a caseKey replaces the job's "no applicability yet"
   * filter, so this is also the RE-extraction path.
   */
  app.post("/cases/:id/extract-applicability", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    try {
      const caseRef = await deps.queue.getCaseRef(id.toLowerCase());
      if (!caseRef) return notFound(c);
      const started = await deps.jobRunner.startJob(
        "regulation-applicability",
        "manual",
        {
          caseKeys: [caseRef.caseKey],
          limit: 1,
        },
      );
      void started.promise.catch((error: unknown) => {
        console.error("[Regulations] applicability extraction run failed", {
          caseKey: caseRef.caseKey,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return c.json(
        {
          ok: true,
          caseKey: caseRef.caseKey,
          jobId: "regulation-applicability",
          runId: started.runId,
        },
        202,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof JobAlreadyRunningError) {
        return errorResponse(c, 409, API_ERROR.applicabilityJobRunning);
      }
      console.error("[Regulations] applicability extraction failed", {
        caseId: id,
        message,
      });
      return errorResponse(c, 502, API_ERROR.extractApplicabilityFailed, {
        message,
      });
    }
  });

  app.post("/cases/:id/reparse", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    try {
      const caseRow = await deps.queue.getCaseRow(id.toLowerCase());
      if (!caseRow) return notFound(c);
      const revision = await deps.queue.getRevision(caseRow.currentRevisionId);
      if (!revision?.snapshotText) {
        // Decision 6 stores the snapshot precisely so this can work; a case
        // without one predates that or lost its source — say so.
        return errorResponse(c, 422, API_ERROR.noSnapshotText);
      }

      // The deterministic coordinate grammar over the STORED snapshot —
      // never a refetch of a source that may have changed or vanished.
      // Described boundaries (statute-reader output) are not reproducible
      // deterministically and would be dropped; that is visible in the
      // proposal, which the admin reviews like any other draft — and undo
      // is a pointer move.
      const parsed = parseJmeldingGeo(revision.snapshotText);
      const proposedGeometries: RegulationRevisionGeometry[] = parsed.areas.map(
        (area) => ({
          name: area.name,
          section: null,
          kind: "closure",
          season: null,
          verticesQuoted: null,
          points: area.points,
          geometrySource: "enumerated",
          coordinateSystem: "WGS84",
          precision: null,
        }),
      );

      const current = await deps.queue.getRevisionGeometries(
        caseRow.currentRevisionId,
      );
      const unchanged = fieldValueEquals(
        current.map((row) => ({ name: row.name, points: row.points })),
        proposedGeometries.map((area) => ({
          name: area.name,
          points: area.points,
        })),
      );
      if (unchanged) {
        return c.json({
          outcome: "no_change",
          areasParsed: proposedGeometries.length,
        });
      }

      // A geometry-only re-parse still writes a FULL field snapshot, so it
      // has to carry the current revision's snapshot-only fields forward or
      // it would quietly drop the admin's display name.
      const currentRevision = await deps.queue.getRevision(
        caseRow.currentRevisionId,
      );
      const revisionId = randomUUID();
      const recordedAt = new Date().toISOString();
      const eventId = await deps.writer.writeRegulationRevisionProposed({
        revisionId,
        caseId: caseRow.id,
        caseKey: caseRow.caseKey,
        baseRevisionId: caseRow.currentRevisionId,
        changes: [
          {
            field: "geometries",
            justification:
              "Deterministic re-parse of the stored source snapshot (parser/POI fix rollout path, decision 6).",
          },
        ],
        fields: editableFieldsOfCase(
          caseRow,
          snapshotOnlyFieldsOf(currentRevision?.fields),
        ),
        geometries: proposedGeometries,
        actor: `admin:${auth.user.username}`,
        recordedAt,
      });
      return c.json(
        {
          outcome: "proposed",
          revisionId,
          eventId,
          areasParsed: proposedGeometries.length,
          areasBefore: current.length,
          recordedAt,
        },
        202,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] reparse failed", { caseId: id, message });
      return flowcoreWriteFailed(c, message);
    }
  });

  // ---------------------------------------------------------------------
  // Admin-defined groups — the navigation layer under each country.
  //
  // Same posture as every other write here: the handler stamps and emits,
  // the projector is the only writer of `regulation_groups`. These five
  // differ from the case routes in one way only: the handler is local, so
  // the write is AWAITED and the projected row is read back and returned
  // (PATHWAYS-C3 mode 1) — an admin renaming a group in a manager needs the
  // resulting list, not an event id.
  //
  // A group's NAME and ORDER take effect at once because they are
  // navigation. Which group a regulation belongs to is what users see, so
  // that rides a proposed revision instead (`groupId` below).
  // ---------------------------------------------------------------------

  const groupJurisdictionSchema = z.string().trim().min(1).max(50);

  const groupListQuerySchema = z.object({
    jurisdiction: groupJurisdictionSchema,
  });
  const groupCreateSchema = z.object({
    jurisdiction: groupJurisdictionSchema,
    name: regulationGroupNameSchema,
  });
  const groupRenameSchema = z.object({ name: regulationGroupNameSchema });
  const groupReorderSchema = z.object({
    jurisdiction: groupJurisdictionSchema,
    groupIds: z.array(z.string().uuid()).min(1),
  });

  /**
   * Read the projected row back after an awaited write. The wait resolves on
   * handler completion, so one read normally suffices; the short retry
   * covers the pathways library's slow-projection recovery, where the event
   * is durable but the handler had not finished when the wait gave up.
   */
  async function readBackGroup(groupId: string) {
    const deadline = Date.now() + 1000;
    for (;;) {
      const group = await deps.groups.getById(groupId);
      if (group) return group;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** 503, not 502: the event IS durable and the row is moments away — the
   * caller should re-read, not retry the write. */
  const groupProjectionPending = (
    c: Parameters<typeof notFound>[0],
    groupId: string,
    eventId: string,
  ) =>
    errorResponse(c, 503, API_ERROR.groupProjectionPending, {
      groupId,
      eventId,
    });

  app.get("/groups", async (c) => {
    const parsed = groupListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return invalidQuery(c, { issues: parsed.error.issues });
    }
    try {
      const groups = await deps.groups.listByJurisdiction(
        parsed.data.jurisdiction,
      );
      return c.json({ groups: groups.map(groupDto) });
    } catch (error) {
      console.error("[Regulations] group list failed", {
        jurisdiction: parsed.data.jurisdiction,
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.queueUnavailable);
    }
  });

  app.post("/groups", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = groupCreateSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    const { jurisdiction, name } = parsed.data;
    try {
      const clash = await deps.groups.findActiveByName(jurisdiction, name);
      if (clash) return groupNameTaken(c, clash.groupId);
      // Appended last among the country's ACTIVE groups. Carried on the
      // event so a replay rebuilds the same order without re-deriving it.
      const active = await deps.groups.listActive(jurisdiction);
      const sortOrder = active.reduce(
        (highest, group) => Math.max(highest, group.sortOrder + 1),
        0,
      );
      const groupId = randomUUID();
      const eventId = await deps.writer.writeRegulationGroupCreated({
        groupId,
        jurisdiction,
        name,
        sortOrder,
        actor: `admin:${auth.user.username}`,
        recordedAt: new Date().toISOString(),
      });
      const group = await readBackGroup(groupId);
      if (!group) return groupProjectionPending(c, groupId, eventId);
      return c.json({ group: groupDto(group) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] group create failed", {
        jurisdiction,
        message,
      });
      return flowcoreWriteFailed(c, message);
    }
  });

  app.post("/groups/reorder", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = groupReorderSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    const { jurisdiction, groupIds } = parsed.data;
    try {
      // The event carries the FULL resulting order, so the request has to
      // name the country's active groups exactly once each — a partial list
      // would leave the unnamed groups at stale positions that no replay
      // would reproduce.
      const active = await deps.groups.listActive(jurisdiction);
      const named = new Set(groupIds);
      const complete =
        named.size === groupIds.length &&
        named.size === active.length &&
        active.every((group) => named.has(group.groupId));
      if (!complete) {
        return invalidPayload(c, { reason: API_REASON.groupOrderMismatch });
      }
      const eventId = await deps.writer.writeRegulationGroupReordered({
        jurisdiction,
        groupIds,
        actor: `admin:${auth.user.username}`,
        recordedAt: new Date().toISOString(),
      });
      const first = groupIds[0] as string;
      const reordered = await readBackGroup(first);
      if (!reordered) return groupProjectionPending(c, first, eventId);
      const groups = await deps.groups.listByJurisdiction(jurisdiction);
      return c.json({ groups: groups.map(groupDto) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] group reorder failed", {
        jurisdiction,
        message,
      });
      return flowcoreWriteFailed(c, message);
    }
  });

  app.post("/groups/:id/rename", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const groupId = c.req.param("id");
    if (!CASE_ID.test(groupId)) return notFound(c);
    const body = await c.req.json().catch(() => null);
    const parsed = groupRenameSchema.safeParse(body);
    if (!parsed.success) {
      return invalidPayload(c, { issues: parsed.error.issues });
    }
    try {
      const existing = await deps.groups.getById(groupId.toLowerCase());
      if (!existing) return notFound(c);
      const clash = await deps.groups.findActiveByName(
        existing.jurisdiction,
        parsed.data.name,
      );
      // Renaming a group to what it already is is a no-op, not a clash.
      if (clash && clash.groupId !== existing.groupId) {
        return groupNameTaken(c, clash.groupId);
      }
      const eventId = await deps.writer.writeRegulationGroupRenamed({
        groupId: existing.groupId,
        name: parsed.data.name,
        actor: `admin:${auth.user.username}`,
        recordedAt: new Date().toISOString(),
      });
      const group = await readBackGroup(existing.groupId);
      if (!group) return groupProjectionPending(c, existing.groupId, eventId);
      return c.json({ group: groupDto(group) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] group rename failed", { groupId, message });
      return flowcoreWriteFailed(c, message);
    }
  });

  app.post("/groups/:id/retire", async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return forbiddenAdminRequired(c);
    }
    const groupId = c.req.param("id");
    if (!CASE_ID.test(groupId)) return notFound(c);
    try {
      const existing = await deps.groups.getById(groupId.toLowerCase());
      if (!existing) return notFound(c);
      // Already retired: nothing to record, and re-recording would move the
      // timestamp that says when the admin actually retired it.
      if (existing.retiredAt) return c.json({ group: groupDto(existing) });
      const eventId = await deps.writer.writeRegulationGroupRetired({
        groupId: existing.groupId,
        actor: `admin:${auth.user.username}`,
        recordedAt: new Date().toISOString(),
      });
      const group = await readBackGroup(existing.groupId);
      if (!group) return groupProjectionPending(c, existing.groupId, eventId);
      return c.json({ group: groupDto(group) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Regulations] group retire failed", { groupId, message });
      return flowcoreWriteFailed(c, message);
    }
  });

  return app;
}
