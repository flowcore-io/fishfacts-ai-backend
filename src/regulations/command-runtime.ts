import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import { timestampToIso } from "@/db/client";
import * as schema from "@/db/schema";
import {
  modeledProposalSchema,
  modeledSourceSchema,
} from "@/events/coastal-commands";
import {
  ANNOUNCEMENT_FLOW_TYPE,
  regulationAdminActionRecordedSchema,
  regulationApprovalRecordedSchema,
  regulationRevisionPointerMovedSchema,
  regulationRevisionProposedSchema,
  regulationValidationRecordedSchema,
  regulationVerdictRecordedSchema,
} from "@/events/contracts";
import { canonicalDigest } from "@/events/json-digest";
import type {
  CaseCommand,
  CaseCommandInput,
} from "@/events/regulation-case-command";
import {
  CASE_COMMAND_BARRIER_EVENT_TYPE,
  SOURCE_OBSERVATION_BARRIER_EVENT_TYPE,
  commandBarrierSchema,
} from "@/events/regulation-command-barrier";
import { and, asc, eq, gt } from "drizzle-orm";
import { RegulationCaseActionProjector } from "./action-projector";
import { blockedShapeState } from "./blocked-shape-state";
import { RegulationCaseProjector } from "./case-projector";
import {
  type RevisionShapeState,
  type SourceRun,
  sourceRunManifestHashOf,
  verifyShapeState,
} from "./coastal-state";
import {
  type DurablePartEmitter,
  RegulationCommandOutbox,
} from "./command-outbox";
import { RegulationCommandProjector } from "./command-projector";
import { caseIdFor, revisionIdFor } from "./ids";
import { SnapshotPartRejectedError } from "./immutable-conflict";
import {
  ModeledCaseRequiresOrderError,
  stageOrderedInput,
} from "./ordered-inputs";
import { pendingCaseInput } from "./pending-source";
import { RegulationRevisionProjector } from "./revision-projector";
import { RegulationShapeCommandProjector } from "./shape-command-projector";
import { validateShapeTopology } from "./shape-topology";
import { RegulationVerdictProjector } from "./verdict-projector";

export class RegulationCaseCommandRuntime {
  private worker?: ReturnType<typeof setInterval>;
  private recovering = false;
  readonly projector: RegulationCommandProjector;
  readonly outbox: RegulationCommandOutbox;
  private ingestion?: {
    emit: DurablePartEmitter;
    ingest: (
      eventType: string,
      payloads: readonly unknown[],
      flowType?: string,
    ) => Promise<string[]>;
  };
  constructor(private readonly db: Database) {
    const domain = new RegulationShapeCommandProjector(
      new RegulationCaseProjector(db),
    );
    this.projector = new RegulationCommandProjector(db, async (tx, c) => {
      const result = await domain.apply(tx, c);
      if (result.status !== "pending")
        await tx
          .update(schema.regulationOrderedInputs)
          .set({ status: "consumed" })
          .where(
            and(
              eq(schema.regulationOrderedInputs.id, c.commandId),
              eq(schema.regulationOrderedInputs.caseId, c.caseId),
            ),
          );
      return result;
    });
    this.outbox = new RegulationCommandOutbox(
      db,
      (parts) => {
        if (!this.ingestion) throw Error("ordered ingestion not attached");
        return this.ingestion.emit(parts);
      },
      () => this.catchup(),
      async (tx, input) => {
        const [row] = await tx
          .select()
          .from(schema.regulationCases)
          .where(eq(schema.regulationCases.id, input.caseId))
          .for("update");
        if (!row && input.operation !== "source")
          throw Error("case not projected");
        const [originalInput] = await tx
          .select({ id: schema.regulationOrderedInputs.id })
          .from(schema.regulationOrderedInputs)
          .where(eq(schema.regulationOrderedInputs.id, input.commandId));
        if (
          row &&
          !originalInput &&
          input.operation !== "source" &&
          (await pendingCaseInput(tx, row, input.commandId))
        )
          throw Error("source or legacy input pending ordering");
      },
    );
  }
  attach(ingestion: NonNullable<RegulationCaseCommandRuntime["ingestion"]>) {
    this.ingestion = ingestion;
  }
  /** Never allow SDK exhausted-retry marking to cross a failed LAST command.
   * A retryable SQL failure leaves this serial handler unresolved. Process
   * termination loses no cursor outcome; the durable event is replayed. */
  async handlePart(payload: unknown) {
    return this.projectUntilCommitted(async () => {
      try {
        return await this.projector.handle(payload);
      } catch (error) {
        if (error instanceof SnapshotPartRejectedError)
          return { status: "rejected" as const };
        throw error;
      }
    });
  }
  async handleBarrier(payload: unknown) {
    const barrier = commandBarrierSchema.parse(payload);
    await this.projectUntilCommitted(async () => {
      await this.recoverDependencies();
      await this.db
        .insert(schema.regulationCommandBarriers)
        .values({
          id: barrier.barrierId,
          recordedAt: new Date(barrier.recordedAt),
        })
        .onConflictDoNothing();
    });
  }
  async recoverDependencies() {
    let after = "";
    for (;;) {
      const pending = await this.db
        .selectDistinct({ caseId: schema.regulationCommandReceipts.caseId })
        .from(schema.regulationCommandReceipts)
        .where(
          and(
            eq(schema.regulationCommandReceipts.status, "pending"),
            gt(schema.regulationCommandReceipts.caseId, after),
          ),
        )
        .orderBy(asc(schema.regulationCommandReceipts.caseId))
        .limit(32);
      if (!pending.length) return;
      for (const row of pending)
        await this.projector.recoverPending(row.caseId);
      after = pending[pending.length - 1].caseId;
    }
  }
  async holdProjection<T>(project: () => Promise<T>): Promise<T> {
    return this.projectUntilCommitted(project);
  }
  async handleSourceBarrier(payload: unknown) {
    const barrier = commandBarrierSchema.parse(payload);
    await this.projectUntilCommitted(() =>
      this.db
        .insert(schema.regulationCommandBarriers)
        .values({
          id: barrier.barrierId,
          recordedAt: new Date(barrier.recordedAt),
        })
        .onConflictDoNothing(),
    );
  }
  private async projectUntilCommitted<T>(
    project: () => Promise<T>,
  ): Promise<T> {
    let failures = 0;
    for (;;) {
      try {
        return await project();
      } catch (error) {
        failures++;
        if (failures === 1 || failures % 30 === 0)
          console.error(
            "[RegulationOrder] projection blocked; common pump held",
            {
              failures,
              message: error instanceof Error ? error.message : "SQL failure",
            },
          );
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2000, 250 * failures)),
        );
      }
    }
  }
  async catchup(timeoutMs = 15_000): Promise<{ barrierId: string }> {
    if (!this.ingestion) throw Error("ordered ingestion not attached");
    let barrierId = "";
    for (const flow of ["source", "command"] as const) {
      barrierId = randomUUID();
      await this.ingestion.ingest(
        flow === "source"
          ? SOURCE_OBSERVATION_BARRIER_EVENT_TYPE
          : CASE_COMMAND_BARRIER_EVENT_TYPE,
        [{ barrierId, recordedAt: new Date().toISOString() }],
        flow === "source" ? ANNOUNCEMENT_FLOW_TYPE : undefined,
      );
      const deadline = Date.now() + timeoutMs;
      let confirmed = false;
      while (Date.now() < deadline) {
        const [receipt] = await this.db
          .select()
          .from(schema.regulationCommandBarriers)
          .where(eq(schema.regulationCommandBarriers.id, barrierId));
        if (receipt) {
          confirmed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!confirmed) throw Error(`${flow} projection catchup unconfirmed`);
    }
    return { barrierId };
  }

  async submit(input: CaseCommandInput) {
    if (input.operation !== "source") {
      const [pending] = await this.db
        .select({ id: schema.regulationOrderedInputs.id })
        .from(schema.regulationOrderedInputs)
        .where(
          and(
            eq(schema.regulationOrderedInputs.caseId, input.caseId),
            eq(schema.regulationOrderedInputs.status, "pending"),
          ),
        )
        .limit(1);
      if (pending) throw Error("source or legacy input pending ordering");
    }
    await this.outbox.reserve(input);
    return this.outbox.deliver(input.commandId);
  }
  async validateOutput(state: RevisionShapeState) {
    return this.db.transaction((tx) => validateShapeTopology(tx, state));
  }
  async receipt(commandId: string) {
    const [receipt] = await this.db
      .select()
      .from(schema.regulationCommandReceipts)
      .where(eq(schema.regulationCommandReceipts.commandId, commandId));
    return receipt ?? null;
  }
  async approvalReceipt(caseId: string, commandId: string) {
    const receipt = await this.receipt(commandId);
    if (!receipt) return null;
    const command = receipt.command as CaseCommand;
    if (
      receipt.caseId !== caseId ||
      command.caseId !== caseId ||
      command.commandId !== commandId ||
      command.operation !== "approval" ||
      (command.data as { approvalId?: string }).approvalId !== commandId
    )
      return undefined;
    return {
      approvalId: commandId,
      commandId,
      caseId,
      revisionId: command.revisionId,
      shapeManifestHash: (command.data as { shapeManifestHash: string })
        .shapeManifestHash,
      metadataOnly: (command.data as { metadataOnly: boolean }).metadataOnly,
      status:
        receipt.status === "applied"
          ? ("applied" as const)
          : receipt.status === "refused"
            ? ("refused" as const)
            : ("pending" as const),
      reason: receipt.reason ?? null,
    };
  }
  async adaptLegacy(
    kind: string,
    eventId: string,
    payload: unknown,
    project: () => Promise<void>,
  ) {
    await this.projectUntilCommitted(async () => {
      try {
        const data = payload as {
          caseId?: string;
          caseKey?: string;
          recordedAt: string;
        };
        if (
          !(await this.legacyDependencies(
            kind,
            data.caseId ?? caseIdFor(data.caseKey ?? ""),
            payload,
          ))
        )
          throw new ModeledCaseRequiresOrderError(
            "legacy dependency not projected",
          );
        await project();
      } catch (error) {
        if (!(error instanceof ModeledCaseRequiresOrderError)) throw error;
        const data = payload as {
          caseId?: string;
          caseKey?: string;
          recordedAt: string;
        };
        const caseId = data.caseId ?? caseIdFor(data.caseKey ?? "");
        await this.db.transaction((tx) =>
          stageOrderedInput(
            tx,
            caseId,
            kind,
            eventId,
            payload,
            data.recordedAt,
          ),
        );
      }
    });
  }
  private async legacyDependencies(
    kind: string,
    caseId: string,
    payload: unknown,
  ) {
    const [row] = await this.db
      .select({ id: schema.regulationCases.id })
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, caseId));
    if (!row) return false;
    const p = payload as Record<string, unknown>;
    const ref =
      kind === "proposal"
        ? p.baseRevisionId
        : kind === "pointer"
          ? p.toRevisionId
          : ["validation", "approval", "verdict"].includes(kind)
            ? p.revisionId
            : null;
    if (!ref) return true;
    const [revision] = await this.db
      .select({ id: schema.regulationCaseRevisions.id })
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, String(ref)));
    return !!revision;
  }
  private async projectDeferredLegacy(kind: string, payload: unknown) {
    const revisions = new RegulationRevisionProjector(this.db);
    switch (kind) {
      case "proposal":
        return revisions.handleProposed(
          regulationRevisionProposedSchema.parse(payload),
        );
      case "pointer":
        return revisions.handlePointerMoved(
          regulationRevisionPointerMovedSchema.parse(payload),
        );
      case "validation":
        return revisions.handleValidationRecorded(
          regulationValidationRecordedSchema.parse(payload),
        );
      case "approval":
        return revisions.handleApprovalRecorded(
          regulationApprovalRecordedSchema.parse(payload),
        );
      case "revoke":
        return new RegulationCaseActionProjector(this.db).handleRecorded(
          regulationAdminActionRecordedSchema.parse(payload),
        );
      case "verdict":
        return new RegulationVerdictProjector(this.db).handleRecorded(
          regulationVerdictRecordedSchema.parse(payload),
        );
      default:
        throw Error("unknown deferred legacy operation");
    }
  }
  start() {
    if (this.worker) return;
    this.worker = setInterval(
      () =>
        void this.recover().catch((error) =>
          console.error("[RegulationOrder] delivery recovery pending", {
            message: error instanceof Error ? error.message : "failure",
          }),
        ),
      1000,
    );
  }
  stop() {
    if (this.worker) clearInterval(this.worker);
    this.worker = undefined;
  }
  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      try {
        await this.outbox.recover(8);
      } catch (error) {
        console.error("[RegulationOrder] delivery remains pending", {
          message:
            error instanceof Error ? error.message : "unconfirmed delivery",
        });
      }
      let cursor: number | undefined;
      for (;;) {
        const inputs = await this.db
          .select()
          .from(schema.regulationOrderedInputs)
          .where(
            and(
              eq(schema.regulationOrderedInputs.status, "pending"),
              cursor !== undefined
                ? gt(schema.regulationOrderedInputs.observationOrder, cursor)
                : undefined,
            ),
          )
          .orderBy(asc(schema.regulationOrderedInputs.observationOrder))
          .limit(8);
        if (!inputs.length) break;
        for (const input of inputs) {
          try {
            await this.recoverInput(input);
          } catch (error) {
            console.error("[RegulationOrder] original input remains pending", {
              inputId: input.id,
              message:
                error instanceof Error ? error.message : "recovery failure",
            });
          }
        }
        const last = inputs[inputs.length - 1];
        cursor = last.observationOrder;
      }
    } finally {
      this.recovering = false;
    }
  }
  /** The source may satisfy an earlier blocked ancestor across ready decisions.
   * Traverse original intake links, never timestamps or UUID ordering. A ready
   * intervening decision stays behind its ancestor after the source applies. */
  private async sourceSuppliesEarlierDependency(
    input: typeof schema.regulationOrderedInputs.$inferSelect,
    ancestor: typeof schema.regulationOrderedInputs.$inferSelect,
  ): Promise<boolean> {
    const parsed = modeledSourceSchema.parse({
      inputId: input.id,
      item: input.payload,
    });
    const target = revisionIdFor(parsed.item.signature);
    const [exists] = await this.db
      .select({ id: schema.regulationCases.id })
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, input.caseId));
    if (!exists) return true; // Only source can establish case genesis.
    const seen = new Set<string>();
    let current: typeof ancestor | undefined = ancestor;
    while (current) {
      if (current.caseId !== input.caseId || seen.has(current.id))
        throw Error("invalid original intake predecessor chain");
      seen.add(current.id);
      if (current.status === "consumed") return false;
      const data = current.payload as Record<string, unknown>;
      const needed =
        current.kind === "proposal"
          ? data.baseRevisionId
          : current.kind === "pointer"
            ? data.toRevisionId
            : data.revisionId;
      if (
        needed === target &&
        !(await this.legacyDependencies(
          current.kind,
          current.caseId,
          current.payload,
        ))
      )
        return true;
      if (!current.predecessorInputId) return false;
      const [previous] = await this.db
        .select()
        .from(schema.regulationOrderedInputs)
        .where(
          eq(schema.regulationOrderedInputs.id, current.predecessorInputId),
        );
      if (!previous) throw Error("original intake predecessor missing");
      current = previous;
    }
    return false;
  }
  private async recoverInput(
    input: typeof schema.regulationOrderedInputs.$inferSelect,
  ) {
    if (canonicalDigest(input.payload) !== input.inputHash)
      throw Error("ordered input integrity mismatch");

    const [delivery] = await this.db
      .select({ id: schema.regulationCommandDeliveries.commandId })
      .from(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.commandId, input.id));
    if (delivery) {
      await this.outbox.deliver(input.id);
      return;
    }
    const receipt = await this.receipt(input.id);
    if (receipt) {
      const {
        schemaVersion: _schema,
        sequence: _seq,
        predecessorCommandId: _pred,
        recordedAt: _time,
        ...original
      } = receipt.command as CaseCommand;
      await this.outbox.reserve(original);
      await this.outbox.deliver(input.id);
      return;
    }
    const [header] = await this.db
      .select({ id: schema.regulationCommandEnvelopes.commandId })
      .from(schema.regulationCommandEnvelopes)
      .where(eq(schema.regulationCommandEnvelopes.commandId, input.id));
    if (header) return; // Partial known event: exact replay must supply original bytes.
    // A later observed intent cannot obtain the first command position while
    // an earlier dependency has not produced any confirmed immutable bytes.
    // Acknowledged predecessor deliveries may proceed; the byte projector
    // stages their successors until the exact predecessor applies/refuses.
    if (input.predecessorInputId) {
      const [previous] = await this.db
        .select()
        .from(schema.regulationOrderedInputs)
        .where(eq(schema.regulationOrderedInputs.id, input.predecessorInputId));
      if (!previous) throw Error("original intake predecessor missing");
      if (previous.status !== "consumed") {
        const [delivery] = await this.db
          .select()
          .from(schema.regulationCommandDeliveries)
          .where(eq(schema.regulationCommandDeliveries.commandId, previous.id));
        if (!delivery || delivery.status !== "acknowledged") {
          // Event-only replay may observe an old decision before the source
          // that creates its named revision. Only that exact dependency may
          // precede the decision; never reorder two ready decisions by clocks.
          const suppliesDependency =
            input.kind === "source" &&
            (await this.sourceSuppliesEarlierDependency(input, previous));
          if (!suppliesDependency) return;
        }
      }
    }
    if (
      input.kind !== "source" &&
      !(await this.legacyDependencies(input.kind, input.caseId, input.payload))
    )
      return;
    const [caseRow] = await this.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, input.caseId));
    if (!caseRow) {
      if (input.kind !== "source") return;
      const parsed = modeledSourceSchema.parse({
        inputId: input.id,
        item: input.payload,
      });
      const revisionId = revisionIdFor(parsed.item.signature);
      await this.outbox.reserve({
        commandId: input.id,
        caseId: input.caseId,
        baseRevisionId: revisionId,
        revisionId,
        operation: "source",
        actor: "collector:fiskeridir-jmelding",
        data: parsed,
      });
      await this.outbox.deliver(input.id);
      return;
    }
    if (caseRow.geometryModelVersion === 0 && input.kind !== "source") {
      if (
        !(await this.legacyDependencies(
          input.kind,
          input.caseId,
          input.payload,
        ))
      )
        return;
      try {
        await this.projectDeferredLegacy(input.kind, input.payload);
      } catch (error) {
        if (error instanceof ModeledCaseRequiresOrderError) return;
        throw error;
      }
      await this.db
        .update(schema.regulationOrderedInputs)
        .set({ status: "consumed" })
        .where(eq(schema.regulationOrderedInputs.id, input.id));
      return;
    }
    const [base] = await this.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, caseRow.currentRevisionId));
    if (!base) return;
    const raw = await this.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, base.id))
      .orderBy(asc(schema.regulationCaseGeometries.position));
    const payload = input.payload as Record<string, unknown>;
    if (canonicalDigest(payload) !== input.inputHash)
      throw Error("ordered input integrity mismatch");
    let operation: CaseCommandInput["operation"];
    let data: unknown;
    let revisionId = base.id;
    const actor =
      typeof payload.actor === "string"
        ? payload.actor
        : "collector:fiskeridir-jmelding";
    let baseRevisionId = base.id;
    switch (input.kind) {
      case "source": {
        const parsed = modeledSourceSchema.parse({
          inputId: input.id,
          item: payload,
        });
        operation = "source";
        data = parsed;
        revisionId = revisionIdFor(parsed.item.signature);
        break;
      }
      case "proposal": {
        operation = "proposal";
        baseRevisionId = String(payload.baseRevisionId);
        revisionId = String(payload.revisionId);
        const [namedBase] = await this.db
          .select()
          .from(schema.regulationCaseRevisions)
          .where(
            and(
              eq(schema.regulationCaseRevisions.id, baseRevisionId),
              eq(schema.regulationCaseRevisions.caseId, input.caseId),
            ),
          );
        if (!namedBase) return;
        const baseRuns = await this.db
          .select()
          .from(schema.regulationCaseGeometries)
          .where(eq(schema.regulationCaseGeometries.revisionId, namedBase.id))
          .orderBy(asc(schema.regulationCaseGeometries.position));
        const proposed = (
          payload.geometries as Array<Record<string, unknown>>
        ).map((g, position) => ({
          ...g,
          position:
            g.position ??
            baseRuns[position]?.position ??
            Math.max(-1, ...baseRuns.map((r) => r.position)) + 1 + position,
        }));
        const runs = proposed as unknown as SourceRun[];
        const copy =
          namedBase.geometryModelVersion === 1 &&
          sourceRunManifestHashOf(baseRuns as unknown as SourceRun[]) ===
            sourceRunManifestHashOf(runs);
        const shapeState = copy
          ? verifyShapeState(namedBase.shapeState, namedBase.snapshotText, runs)
          : blockedShapeState(
              revisionId,
              namedBase.snapshotText,
              runs,
              namedBase.sourceTextComplete,
            );
        data = modeledProposalSchema.parse({
          fields: payload.fields,
          geometries: proposed,
          changes: payload.changes,
          shapeState,
          snapshot: {
            text: namedBase.snapshotText,
            url: namedBase.snapshotUrl,
            fetchedAt: timestampToIso(namedBase.snapshotFetchedAt) ?? null,
            fragmentId: namedBase.snapshotFragmentId,
          },
        });
        break;
      }
      case "pointer":
        operation = "pointer";
        data = {
          pointerMoveId: payload.pointerMoveId,
          toRevisionId: payload.toRevisionId,
        };
        revisionId = String(payload.toRevisionId);
        break;
      case "validation":
        operation = "validation";
        data = {
          validationId: payload.validationId,
          scope: payload.scope,
          validated: payload.validated,
          note: payload.note,
        };
        revisionId = String(payload.revisionId);
        break;
      case "approval":
        operation = "approval";
        data = payload;
        revisionId = String(payload.revisionId);
        break; // Old approval lacks manifest and is durably refused; no guessing.
      case "revoke":
        operation = "revoke";
        data = { actionId: payload.actionId, action: payload.action };
        break;
      case "verdict":
        operation = "verdict";
        data = payload;
        revisionId = String(payload.revisionId);
        break;
      default:
        throw Error("unknown ordered legacy input kind");
    }
    await this.outbox.reserve({
      commandId: input.id,
      caseId: input.caseId,
      baseRevisionId,
      revisionId,
      actor,
      operation,
      data,
    });
    await this.outbox.deliver(input.id);
  }
}
