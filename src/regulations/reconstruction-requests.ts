import type { Database } from "@/db/client";
import { timestampToIso } from "@/db/client";
import * as schema from "@/db/schema";
import { modeledProposalSchema } from "@/events/coastal-commands";
import { regulationRevisionGeometrySchema } from "@/events/contracts";
import { canonicalDigest, canonicalJson } from "@/events/json-digest";
import {
  type ReconstructionIntent,
  reconstructionIntentSchema,
} from "@/events/reconstruction-request";
import {
  type CaseCommandInput,
  caseCommandSchema,
  commandPartSchema,
} from "@/events/regulation-case-command";
import {
  MAX_SNAPSHOT_BYTES,
  type SnapshotManifest,
  type SnapshotPart,
  manifestOf,
  reconstructSnapshot,
} from "@/events/regulation-snapshot-parts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  BoundaryResourceLimitError,
  parseBoundaryInventory,
} from "./boundary-parser";
import {
  type CoastalReconstruction,
  ReconstructionBlocked,
} from "./coastal-reconstruction";
import { type RevisionShapeState, verifyShapeState } from "./coastal-state";
import type { RegulationCaseCommandRuntime } from "./command-runtime";
import { reconstructionIds } from "./reconstruction-request-projector";

function canonicalIntent(
  rawIntent: ReconstructionIntent,
): ReconstructionIntent {
  return {
    ...rawIntent,
    requestId: rawIntent.requestId.toLowerCase(),
    baseRevisionId: rawIntent.baseRevisionId.toLowerCase(),
    ...(rawIntent.kind === "joins"
      ? {
          shapeId: rawIntent.shapeId.toLowerCase(),
          joinCandidateIds: rawIntent.joinCandidateIds.map((id) =>
            id.toLowerCase(),
          ),
        }
      : rawIntent.kind === "faces"
        ? {
            shapeId: rawIntent.shapeId.toLowerCase(),
            faceIds: rawIntent.faceIds.map((id) => id.toLowerCase()),
          }
        : {}),
  };
}

export class ReconstructionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
/** Request state is event-derived. This worker only reserves/emits immutable
 * result bytes; it cannot change revisions, request outcomes or publication. */
export class RegulationReconstructionRequests {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly db: Database,
    private readonly commands: RegulationCaseCommandRuntime,
    private readonly geometry: CoastalReconstruction,
  ) {}
  private input(
    caseId: string,
    actor: string,
    intent: ReconstructionIntent,
  ): CaseCommandInput {
    return {
      commandId: intent.requestId,
      caseId,
      actor,
      baseRevisionId: intent.baseRevisionId,
      revisionId: reconstructionIds(intent.requestId).revisionId,
      operation: "request",
      data: intent,
    };
  }
  async register(
    rawCaseId: string,
    actor: string,
    rawIntent: ReconstructionIntent,
  ) {
    // UUID spelling is not identity. Canonicalize before hashing/reserving
    // immutable bytes, matching the mounted status route's lowercase lookup.
    // Replay parses original event bytes without applying this write transform.
    const caseId = rawCaseId.toLowerCase();
    const intent = canonicalIntent(rawIntent);
    const input = this.input(caseId, actor, intent);
    // Historic casing may only become visible while replay catches up after
    // operational cache loss. Resolve its immutable identity after the durable
    // source/command barriers, before choosing any bytes to reserve. The outbox
    // retains its own reservation barrier and prefix reconciliation.
    await this.commands.catchup();
    const storedId = await this.storedRequestId(intent.requestId);
    if (storedId && storedId !== intent.requestId) {
      // A pre-fix accepted spelling keeps its original immutable command bytes.
      // UUID-equivalent retries must restore that command, not allocate a twin.
      const original = await this.originalRequest(storedId);
      if (
        !original ||
        original.commandId !== storedId ||
        original.revisionId !== reconstructionIds(storedId).revisionId ||
        original.caseId !== caseId ||
        original.actor !== actor ||
        original.operation !== "request" ||
        canonicalDigest(
          canonicalIntent(reconstructionIntentSchema.parse(original.data)),
        ) !== canonicalDigest(intent)
      )
        throw new ReconstructionRequestError("request_id_conflict", 409);
      const {
        schemaVersion: _v,
        sequence: _s,
        predecessorCommandId: _p,
        recordedAt: _t,
        ...originalInput
      } = original;
      await this.commands.submit(originalInput);
      return {
        requestId: intent.requestId,
        status: "pending" as const,
        statusUrl: `/api/regulations/cases/${caseId}/reconstruction-requests/${intent.requestId}`,
      };
    }
    const [known] = await this.db
      .select()
      .from(schema.regulationReconstructionRequests)
      .where(eq(schema.regulationReconstructionRequests.id, intent.requestId));
    const [delivery] = await this.db
      .select()
      .from(schema.regulationCommandDeliveries)
      .where(
        eq(schema.regulationCommandDeliveries.commandId, intent.requestId),
      );
    const [header] = await this.db
      .select()
      .from(schema.regulationCommandEnvelopes)
      .where(eq(schema.regulationCommandEnvelopes.commandId, intent.requestId));
    if (
      known &&
      (known.caseId !== caseId ||
        known.inputHash !== canonicalDigest({ intent, actor, caseId }))
    )
      throw new ReconstructionRequestError("request_id_conflict", 409);
    if (
      delivery &&
      (delivery.caseId !== caseId ||
        delivery.inputHash !== canonicalDigest(input))
    )
      throw new ReconstructionRequestError("request_id_conflict", 409);
    // Known UUID retry restores original bytes through the existing delivery
    // reconciliation; never fail it solely because its draft already applied.
    if (!known && !delivery && !header) {
      const [row] = await this.db
        .select()
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, caseId));
      if (!row) throw new ReconstructionRequestError("not_found", 404);
      if (row.currentRevisionId !== intent.baseRevisionId)
        throw new ReconstructionRequestError("stale_revision", 409, {
          currentRevisionId: row.currentRevisionId,
          namedRevisionId: intent.baseRevisionId,
        });
      const base = await this.base(caseId, intent.baseRevisionId);
      if (base.revision.snapshotText === null)
        throw new ReconstructionRequestError("no_snapshot_text", 422);
      if (intent.kind === "start") {
        const [dataset] = await this.db
          .select({ id: schema.regulationLandDatasets.id })
          .from(schema.regulationLandDatasets)
          .where(eq(schema.regulationLandDatasets.id, intent.landDatasetId));
        if (!dataset)
          throw new ReconstructionRequestError("land_dataset_unavailable", 503);
      }

      if (intent.kind !== "start")
        this.checkSelection(
          intent,
          verifyShapeState(
            base.revision.shapeState,
            base.revision.snapshotText,
            base.runs,
          ),
        );
    }
    try {
      await this.commands.submit(input);
    } catch (error) {
      if (error instanceof Error && error.message === "command id conflict")
        throw new ReconstructionRequestError("request_id_conflict", 409);
      throw error;
    }
    return {
      requestId: intent.requestId,
      status: "pending" as const,
      statusUrl: `/api/regulations/cases/${caseId}/reconstruction-requests/${intent.requestId}`,
    };
  }
  private checkSelection(
    intent: Exclude<ReconstructionIntent, { kind: "start" }>,
    state: RevisionShapeState,
  ) {
    const shape = state.shapes.find((s) => s.id === intent.shapeId);
    const invalid = (reason: string): never => {
      throw new ReconstructionRequestError("invalid_payload", 400, { reason });
    };
    if (!shape) return invalid("shape_not_of_revision");
    if (shape.shapeHash !== intent.shapeHash)
      throw new ReconstructionRequestError("shape_hash_mismatch", 409, {
        expectedHash: shape.shapeHash,
        receivedHash: intent.shapeHash,
      });
    const ids =
      intent.kind === "joins" ? intent.joinCandidateIds : intent.faceIds;
    if (new Set(ids).size !== ids.length) invalid("duplicate_selection");
    if (intent.kind === "joins") {
      if (!shape.candidateEnumerationComplete)
        invalid("candidate_enumeration_incomplete");
      const candidates = ids.map((id) =>
        shape.joinCandidates.find((c) => c.id === id),
      );
      if (candidates.some((c) => !c)) invalid("foreign_candidate");
      const refs = candidates.map(
        (c) => c && `${c.endpoint.runPosition}:${c.endpoint.pointIndex}`,
      );
      if (
        !shape.requiredEndpoints.length ||
        ids.length !== shape.requiredEndpoints.length ||
        new Set(refs).size !== refs.length ||
        shape.requiredEndpoints.some(
          (e) => !refs.includes(`${e.runPosition}:${e.pointIndex}`),
        )
      )
        invalid("missing_endpoint_selection");
    } else {
      if (shape.joinConfigurationHash !== intent.joinConfigurationHash)
        invalid("face_configuration_mismatch");
      if (!shape.faceEnumerationComplete)
        invalid("candidate_enumeration_incomplete");
      if (!ids.length) invalid("invalid_shape_selection");
      if (ids.some((id) => !shape.faceCandidates.some((f) => f.id === id)))
        invalid("foreign_candidate");
    }
  }
  private async storedRequestId(requestId: string) {
    const rows = await this.db.execute<{ id: string }>(sql`
      select command_id as id from regulation_command_deliveries
      where lower(command_id) = ${requestId}
      union
      select command_id as id from regulation_command_envelopes
      where lower(command_id) = ${requestId}
      limit 2`);
    if (rows.length > 1)
      throw new ReconstructionRequestError("request_id_conflict", 409);
    return rows[0]?.id ?? null;
  }
  private async originalRequest(requestId: string) {
    const receipt = await this.commands.receipt(requestId);
    if (receipt) return caseCommandSchema.parse(receipt.command);
    const [delivery] = await this.db
      .select()
      .from(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.commandId, requestId));
    if (!delivery) {
      const [assembly] = await this.db
        .select()
        .from(schema.regulationSnapshotAssemblies)
        .where(eq(schema.regulationSnapshotAssemblies.assemblyId, requestId));
      const parts = await this.db
        .select()
        .from(schema.regulationSnapshotParts)
        .where(eq(schema.regulationSnapshotParts.assemblyId, requestId))
        .orderBy(asc(schema.regulationSnapshotParts.partNumber));
      const manifest = assembly?.manifest as SnapshotManifest | undefined;
      if (!manifest || parts.length !== manifest.totalParts)
        throw Error("known request incomplete; await exact durable replay");
      return caseCommandSchema.parse(
        reconstructSnapshot(
          manifest,
          parts.map((p) => p.payload as SnapshotPart),
        ),
      );
    }
    const parts = commandPartSchema.array().min(1).parse(delivery.parts);
    return caseCommandSchema.parse(
      reconstructSnapshot(
        manifestOf(parts[0].part),
        parts.map((p) => p.part),
      ),
    );
  }
  async status(caseId: string, rawRequestId: string) {
    const requestId = rawRequestId.toLowerCase();
    const storedId = (await this.storedRequestId(requestId)) ?? requestId;
    const [request] = await this.db
      .select()
      .from(schema.regulationReconstructionRequests)
      .where(
        and(
          eq(schema.regulationReconstructionRequests.id, storedId),
          eq(schema.regulationReconstructionRequests.caseId, caseId),
        ),
      );
    if (request)
      return {
        requestId,
        status: request.status as "pending" | "completed" | "failed",
        revisionId: request.status === "completed" ? request.revisionId : null,
        error: request.error,
        recordedAt: timestampToIso(request.recordedAt),
      };
    const receipt = await this.commands.receipt(storedId);
    if (receipt && receipt.caseId === caseId) {
      const command = receipt.command as CaseCommandInput & {
        recordedAt: string;
      };
      if (command.operation !== "request") return null;
      return {
        requestId,
        status: receipt.status === "refused" ? "failed" : "pending",
        revisionId: null,
        error:
          receipt.status === "refused"
            ? { error: "reconstruction_refused", reason: receipt.reason }
            : null,
        recordedAt: command.recordedAt,
      };
    }
    const [delivery] = await this.db
      .select()
      .from(schema.regulationCommandDeliveries)
      .where(
        and(
          eq(schema.regulationCommandDeliveries.commandId, storedId),
          eq(schema.regulationCommandDeliveries.caseId, caseId),
        ),
      );
    // Operational cache can report delivery uncertainty only, never applied state.
    if (delivery) {
      const parts = commandPartSchema.array().min(1).parse(delivery.parts);
      const command = caseCommandSchema.parse(
        reconstructSnapshot(
          manifestOf(parts[0].part),
          parts.map((p) => p.part),
        ),
      );
      if (
        command.commandId !== storedId ||
        command.caseId !== caseId ||
        command.operation !== "request"
      )
        return null;
      return {
        requestId,
        status: "pending" as const,
        revisionId: null,
        error: null,
        recordedAt: command.recordedAt,
      };
    }
    return null;
  }
  private async base(caseId: string, revisionId: string) {
    const [revision] = await this.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(
        and(
          eq(schema.regulationCaseRevisions.id, revisionId),
          eq(schema.regulationCaseRevisions.caseId, caseId),
        ),
      );
    if (!revision) throw new ReconstructionRequestError("not_found", 404);
    const rows = await this.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revisionId))
      .orderBy(asc(schema.regulationCaseGeometries.position));
    const runs = rows.map((r) => ({
      ...regulationRevisionGeometrySchema.parse(r),
      position: r.position,
    }));
    return { revision, runs };
  }
  start() {
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.recover().catch((error) =>
          console.error("[Reconstruction] recovery remains pending", {
            message: error instanceof Error ? error.message : "worker failure",
          }),
        );
      }, 1000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async recover() {
    if (this.running) return this.running;
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async work() {
    await this.commands.catchup();
    let cursor: string | undefined;
    let firstError: unknown;
    for (;;) {
      const requests = await this.db
        .select()
        .from(schema.regulationReconstructionRequests)
        .where(
          and(
            eq(schema.regulationReconstructionRequests.status, "pending"),
            cursor
              ? gt(schema.regulationReconstructionRequests.id, cursor)
              : undefined,
          ),
        )
        .orderBy(asc(schema.regulationReconstructionRequests.id))
        .limit(8);
      if (!requests.length) break;
      for (const request of requests) {
        try {
          await this.db.transaction(async (tx) => {
            const lock = await tx.execute(
              sql`select pg_try_advisory_xact_lock(hashtextextended(${`regulation-reconstruction-work:${request.caseId}`},0)) locked`,
            );
            if (!lock[0]?.locked) return;
            const [current] = await tx
              .select()
              .from(schema.regulationReconstructionRequests)
              .where(
                eq(schema.regulationReconstructionRequests.id, request.id),
              );
            if (current?.status !== "pending") return;
            const ids = reconstructionIds(request.id);
            // Crash after reservation/emission retries immutable output, never land.
            for (const id of [ids.resultCommandId, ids.failureCommandId]) {
              const [delivery] = await tx
                .select()
                .from(schema.regulationCommandDeliveries)
                .where(eq(schema.regulationCommandDeliveries.commandId, id));
              const receipt = await this.commands.receipt(id);
              const [header] = await tx
                .select()
                .from(schema.regulationCommandEnvelopes)
                .where(eq(schema.regulationCommandEnvelopes.commandId, id));
              if (delivery) {
                await this.commands.outbox.deliver(id);
                return;
              }
              if (receipt || header) return; // Durable replay supplies existing exact body.
            }
            const unsettled = await tx.execute(sql`select exists(
        select 1 from regulation_command_envelopes h where h.case_id=${request.caseId}
        and h.sequence>coalesce((select sequence from regulation_command_tails where case_id=${request.caseId}),0)
        union all select 1 from regulation_command_deliveries d where d.case_id=${request.caseId}
        and d.sequence>coalesce((select sequence from regulation_command_tails where case_id=${request.caseId}),0)
      ) unsettled`);
            if (unsettled[0]?.unsettled) return;
            const intent = request.intent as ReconstructionIntent;
            const base = await this.base(
              request.caseId,
              request.baseRevisionId,
            );
            const result: CaseCommandInput = {
              commandId: ids.resultCommandId,
              caseId: request.caseId,
              baseRevisionId: request.baseRevisionId,
              revisionId: ids.revisionId,
              operation: "proposal",
              actor: request.actor,
              data: null,
            };
            try {
              let state: RevisionShapeState;
              if (intent.kind === "start")
                state = await this.geometry.propose(
                  parseBoundaryInventory(
                    ids.revisionId,
                    base.revision.snapshotText,
                    base.runs.map((r) => ({ ...r, paragraph: null })),
                    base.revision.sourceTextComplete,
                  ),
                  base.revision.snapshotText,
                  base.runs,
                  intent.landDatasetId,
                );
              else {
                const original = verifyShapeState(
                  base.revision.shapeState,
                  base.revision.snapshotText,
                  base.runs,
                );
                this.checkSelection(intent, original);
                state =
                  intent.kind === "joins"
                    ? await this.geometry.selectJoins(
                        original,
                        base.revision.snapshotText,
                        base.runs,
                        intent.shapeId,
                        intent.shapeHash,
                        intent.joinCandidateIds,
                        intent.justification,
                      )
                    : await this.geometry.selectFaces(
                        original,
                        base.revision.snapshotText,
                        base.runs,
                        intent.shapeId,
                        intent.shapeHash,
                        intent.joinConfigurationHash,
                        intent.faceIds,
                        intent.justification,
                      );
              }
              result.data = modeledProposalSchema.parse({
                reconstructionRequestId: request.id,
                fields: base.revision.fields,
                geometries: base.runs,
                shapeState: state,
                changes: [
                  {
                    field: "geometries",
                    justification:
                      intent.kind === "start"
                        ? "Explicit bounded coastline reconstruction request"
                        : intent.justification,
                  },
                ],
                snapshot: {
                  text: base.revision.snapshotText,
                  url: base.revision.snapshotUrl,
                  fetchedAt:
                    timestampToIso(base.revision.snapshotFetchedAt) ?? null,
                  fragmentId: base.revision.snapshotFragmentId,
                },
              });
              // Conservative envelope headroom binds the COMPLETE proposal, source,
              // plans, candidates and provenance. Oversize fails, never truncates.
              if (
                Buffer.byteLength(canonicalJson(result), "utf8") + 512 >
                MAX_SNAPSHOT_BYTES
              )
                throw new ReconstructionBlocked("resource_limit");
            } catch (error) {
              if (
                !(error instanceof ReconstructionBlocked) &&
                !(error instanceof ReconstructionRequestError) &&
                !(error instanceof BoundaryResourceLimitError)
              )
                throw error;
              result.commandId = ids.failureCommandId;
              result.operation = "request-failure";
              result.data = {
                requestId: request.id,
                error:
                  error instanceof ReconstructionBlocked
                    ? error.reason
                    : error instanceof BoundaryResourceLimitError
                      ? "resource_limit"
                      : error.code,
              };
            }
            await this.commands.submit(result);
          });
        } catch (error) {
          firstError ??= error;
        }
      }
      cursor = requests[requests.length - 1].id;
    }
    if (firstError) throw firstError;
  }
}
