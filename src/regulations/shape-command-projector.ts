import { timestampToIso } from "@/db/client";
import * as schema from "@/db/schema";
import {
  modeledApprovalSchema,
  modeledPointerSchema,
  modeledProposalSchema,
  modeledRevokeSchema,
  modeledSourceSchema,
  modeledValidationSchema,
  modeledVerdictSchema,
} from "@/events/coastal-commands";
import { regulationRevisionFieldsSchema } from "@/events/contracts";
import { canonicalDigest } from "@/events/json-digest";
import type { CaseCommand } from "@/events/regulation-case-command";
import { pointsToMultipointWkt } from "@/jmelding/geo-parser";
import { jmeldingFragmentKey } from "@/jobs/jmelding-fragments";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { caseEffectOf } from "./action-projector";
import {
  type ApprovalEvidence,
  verifyApprovalEvidence,
} from "./approval-evidence";
import { type RegulationCaseProjector, sourceTypeOf } from "./case-projector";
import {
  type RevisionShapeState,
  normalApprovalBlockers,
  verifyShapeState,
} from "./coastal-state";
import { geometryIdFor } from "./ids";
import { caseIdFor, revisionIdFor } from "./ids";
import { pendingCaseInput } from "./pending-source";
import { caseColumnsOfFields } from "./revision-fields";
import {
  ShapeCommandRejectedError,
  verifyShapeCommand,
} from "./shape-rejection";
import { validateShapeTopology } from "./shape-topology";
import type { SnapshotApplication, SnapshotTx } from "./snapshot-assembler";
import { verdictConfidenceOf } from "./verdict";
const refused = (reason: string): SnapshotApplication => ({
  status: "refused",
  reason,
});
/** Domain mutations run ONLY in the verified command projector transaction.
 * Runtime registration waits for legacy/source adapters and catchup proof. */
export class RegulationShapeCommandProjector {
  constructor(private readonly sources?: RegulationCaseProjector) {}
  async apply(
    tx: SnapshotTx,
    command: CaseCommand,
  ): Promise<SnapshotApplication> {
    try {
      return await this.applyVerified(tx, command);
    } catch (error) {
      if (error instanceof ShapeCommandRejectedError)
        return refused(error.message);
      throw error;
    }
  }
  private async applyVerified(
    tx: SnapshotTx,
    command: CaseCommand,
  ): Promise<SnapshotApplication> {
    const [caseRow] = await tx
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, command.caseId))
      .for("update");
    if (command.operation === "source") {
      const parsed = modeledSourceSchema.safeParse(command.data);
      if (!parsed.success || !this.sources)
        return refused("invalid source adapter input");
      if (
        parsed.data.inputId !== command.commandId ||
        command.revisionId !== revisionIdFor(parsed.data.item.signature)
      )
        return refused("source revision identity mismatch");
      const item = parsed.data.item;
      if (!caseRow && command.baseRevisionId !== command.revisionId)
        return {
          status: "pending",
          reason: "source predecessor case not projected",
        };
      if (caseRow) {
        const [sourceBase] = await tx
          .select({ id: schema.regulationCaseRevisions.id })
          .from(schema.regulationCaseRevisions)
          .where(
            and(
              eq(schema.regulationCaseRevisions.id, command.baseRevisionId),
              eq(schema.regulationCaseRevisions.caseId, command.caseId),
            ),
          );
        if (!sourceBase)
          return { status: "pending", reason: "source base not projected" };
      }
      const ref =
        item.jmNumber ??
        jmeldingFragmentKey(item.url, {
          region: item.region,
          jmNumber: item.jmNumber,
        });
      if (caseIdFor(`${sourceTypeOf(item)}:${ref}`) !== command.caseId)
        return refused("source case identity mismatch");
      const sourceResult = await this.sources.projectInTransaction(
        tx,
        item,
        true,
      );
      if (sourceResult.outcome === "quarantined")
        return refused("conflicting immutable source revision");
      await tx
        .update(schema.regulationOrderedInputs)
        .set({ status: "consumed" })
        .where(
          and(
            eq(schema.regulationOrderedInputs.id, parsed.data.inputId),
            eq(schema.regulationOrderedInputs.caseId, command.caseId),
          ),
        );
      return { status: "applied" };
    }
    if (!caseRow) return { status: "pending", reason: "case not projected" };
    const [base] = await tx
      .select()
      .from(schema.regulationCaseRevisions)
      .where(
        and(
          eq(schema.regulationCaseRevisions.id, command.baseRevisionId),
          eq(schema.regulationCaseRevisions.caseId, command.caseId),
        ),
      );
    if (!base)
      return { status: "pending", reason: "base revision not projected" };
    // UUIDs are immutable across cases and commands. A duplicate domain ID
    // is a terminal refusal, never an endless SQL uniqueness retry.
    const dataIds = command.data as Record<string, unknown>;
    const identityTable =
      command.operation === "proposal"
        ? schema.regulationCaseRevisions
        : command.operation === "validation" ||
            command.operation === "coverage-validation"
          ? schema.regulationCaseValidations
          : command.operation === "approval"
            ? schema.regulationCaseApprovals
            : command.operation === "revoke" || command.operation === "pointer"
              ? schema.regulationCaseActions
              : null;
    const identity =
      command.operation === "proposal"
        ? command.revisionId
        : command.operation === "approval"
          ? dataIds?.approvalId
          : command.operation === "revoke"
            ? dataIds?.actionId
            : command.operation === "pointer"
              ? dataIds?.pointerMoveId
              : dataIds?.validationId;
    if (identityTable && typeof identity === "string") {
      const [existing] = await tx
        .select({ id: identityTable.id })
        .from(identityTable)
        .where(eq(identityTable.id, identity));
      if (existing) return refused("immutable domain identity already used");
    }
    if (command.operation === "revoke") {
      const parsed = modeledRevokeSchema.safeParse(command.data);
      if (!parsed.success) return refused("invalid admin action schema");
      const action = parsed.data;
      await tx.insert(schema.regulationCaseActions).values({
        id: action.actionId,
        caseId: command.caseId,
        kind: action.action.kind,
        action: action.action,
        actor: command.actor,
        recordedAt: new Date(command.recordedAt),
      });
      const effect = caseEffectOf(
        action.action,
        caseRow.publishedRevisionId !== null,
      );
      if (effect)
        await tx
          .update(schema.regulationCases)
          .set({ ...effect, updatedAt: new Date(command.recordedAt) })
          .where(eq(schema.regulationCases.id, command.caseId));
      if (
        action.action.kind === "mark_read" &&
        action.action.read &&
        caseRow.adminStatus === "unread"
      )
        await tx
          .update(schema.regulationCases)
          .set({ adminStatus: "under_review" })
          .where(eq(schema.regulationCases.id, command.caseId));
      return { status: "applied" };
    }
    if (command.operation === "proposal")
      return this.proposal(tx, command, caseRow, base);
    const [revision] = await tx
      .select()
      .from(schema.regulationCaseRevisions)
      .where(
        and(
          eq(schema.regulationCaseRevisions.id, command.revisionId),
          eq(schema.regulationCaseRevisions.caseId, command.caseId),
        ),
      );
    if (!revision)
      return { status: "pending", reason: "target revision not projected" };
    if (command.operation === "pointer") {
      const parsed = modeledPointerSchema.safeParse(command.data);
      if (!parsed.success || parsed.data.toRevisionId !== command.revisionId)
        return refused("pointer target identity mismatch");
      if (caseRow.currentRevisionId !== command.baseRevisionId)
        return refused("stale pointer base");
      const fields = regulationRevisionFieldsSchema.safeParse(revision.fields);
      if (!fields.success)
        return refused("pointer target lacks complete field snapshot");
      await tx.insert(schema.regulationCaseActions).values({
        id: parsed.data.pointerMoveId,
        caseId: command.caseId,
        kind: "revision_pointer_moved",
        action: parsed.data,
        actor: command.actor,
        recordedAt: new Date(command.recordedAt),
      });
      await tx
        .update(schema.regulationCases)
        .set({
          ...caseColumnsOfFields(fields.data),
          currentRevisionId: command.revisionId,
          regulatoryValidated: false,
          geometryValidated: false,
          verdictStatus: revision.verdictStatus,
          adminStatus: "under_review",
          regulationStatus: caseRow.publishedRevisionId ? "published" : "draft",
          updatedAt: new Date(command.recordedAt),
        })
        .where(
          and(
            eq(schema.regulationCases.id, command.caseId),
            eq(
              schema.regulationCases.currentRevisionId,
              command.baseRevisionId,
            ),
          ),
        );
      return { status: "applied" };
    }
    if (command.operation === "verdict") {
      const parsed = modeledVerdictSchema.safeParse(command.data);
      if (
        !parsed.success ||
        parsed.data.revisionId !== command.revisionId ||
        parsed.data.caseKey !== caseRow.caseKey
      )
        return refused("verdict identity mismatch");
      const v = parsed.data;
      await tx
        .update(schema.regulationCaseRevisions)
        .set({
          verdictStatus: v.status,
          verdict: v.status === "ok" ? v.issues : null,
          verdictModel: v.model,
          verdictConfidence:
            v.status === "ok" ? verdictConfidenceOf(v.issues) : null,
          verdictRecordedAt: new Date(command.recordedAt),
          verdictError: v.status === "failed" ? v.error : null,
        })
        .where(eq(schema.regulationCaseRevisions.id, command.revisionId));
      if (caseRow.currentRevisionId === command.revisionId)
        await tx
          .update(schema.regulationCases)
          .set({ verdictStatus: v.status })
          .where(eq(schema.regulationCases.id, command.caseId));
      return { status: "applied" };
    }
    if (revision.geometryModelVersion !== 1)
      return refused("modeled revision required");
    const runs = await tx
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revision.id))
      .orderBy(asc(schema.regulationCaseGeometries.position));
    const state = verifyShapeCommand(() =>
      verifyShapeState(
        revision.shapeState,
        revision.snapshotText,
        runs.map((r) => ({
          position: r.position,
          points: r.points as Array<{ lat: number; lon: number }>,
        })),
      ),
    );
    if (
      command.operation === "validation" ||
      command.operation === "coverage-validation"
    )
      return this.validation(tx, command, caseRow, state);
    if (command.operation === "approval")
      return this.approval(tx, command, caseRow, state);
    return refused("operation adapter not installed");
  }
  private async proposal(
    tx: SnapshotTx,
    c: CaseCommand,
    caseRow: typeof schema.regulationCases.$inferSelect,
    base: typeof schema.regulationCaseRevisions.$inferSelect,
  ): Promise<SnapshotApplication> {
    const parsed = modeledProposalSchema.safeParse(c.data);
    if (!parsed.success) return refused("invalid full proposal schema");
    const data = parsed.data;
    if (caseRow.currentRevisionId !== c.baseRevisionId)
      return refused("stale base revision");
    if (c.revisionId === c.baseRevisionId)
      return refused("revision identity reused");
    if (
      data.snapshot.text !== base.snapshotText ||
      data.snapshot.url !== base.snapshotUrl ||
      data.snapshot.fragmentId !== base.snapshotFragmentId ||
      data.snapshot.fetchedAt !==
        (timestampToIso(base.snapshotFetchedAt) ?? null)
    )
      return refused("proposal cannot alter source snapshot");
    if (
      new Set(data.geometries.map((g) => g.position)).size !==
      data.geometries.length
    )
      return refused("duplicate raw run position");
    const state = verifyShapeCommand(() =>
      verifyShapeState(data.shapeState, data.snapshot.text, data.geometries),
    );
    if (
      state.coverage.sourceAvailability === "complete_snapshot" &&
      (base.sourceTextComplete === false ||
        base.snapshotText === null ||
        base.snapshotText.length >= 500000)
    )
      return refused("known incomplete source cannot become complete coverage");
    const rawBase = await tx
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, base.id))
      .orderBy(asc(schema.regulationCaseGeometries.position));
    const signature = (runs: Array<{ position: number; points: unknown }>) =>
      canonicalDigest(
        runs.map((r) => ({ position: r.position, points: r.points })),
      );
    if (
      signature(rawBase) !== signature(data.geometries) &&
      state.shapes.some((s) => s.geojson !== null)
    )
      return refused("changed source points require blocked reconstruction");
    await validateShapeTopology(tx, state);
    const [position] = await tx
      .select({
        max: sql<number>`coalesce(max(${schema.regulationCaseRevisions.position}),-1)::int`,
      })
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.caseId, c.caseId));
    await tx.insert(schema.regulationCaseRevisions).values({
      id: c.revisionId,
      caseId: c.caseId,
      position: position.max + 1,
      contentHash: base.contentHash,
      changeType: base.changeType,
      author: c.actor,
      snapshotText: base.snapshotText,
      sourceTextComplete: base.sourceTextComplete,
      snapshotUrl: base.snapshotUrl,
      snapshotFetchedAt: base.snapshotFetchedAt,
      snapshotFragmentId: base.snapshotFragmentId,
      parserVersion: base.parserVersion,
      parseStatus: base.parseStatus,
      parseError: base.parseError,
      verdictStatus: base.verdictStatus,
      verdict: base.verdict,
      verdictError: base.verdictError,
      verdictModel: base.verdictModel,
      verdictConfidence: base.verdictConfidence,
      verdictRecordedAt: base.verdictRecordedAt,
      sourceEventSignature: `case-command:${c.commandId}`,
      baseRevisionId: base.id,
      changes: data.changes,
      fields: data.fields,
      geometryModelVersion: 1,
      shapeState: state,
      createdAt: new Date(c.recordedAt),
    });
    for (const g of data.geometries) {
      const wkt = pointsToMultipointWkt(g.points);
      await tx.insert(schema.regulationCaseGeometries).values({
        ...g,
        id: geometryIdFor(c.revisionId, g.position),
        caseId: c.caseId,
        revisionId: c.revisionId,
        geom: wkt ? (sql`ST_GeomFromText(${wkt},4326)` as never) : null,
        geometryValidated: false,
      });
    }
    await tx
      .update(schema.regulationCases)
      .set({
        ...caseColumnsOfFields(data.fields),
        currentRevisionId: c.revisionId,
        geometryModelVersion: 1,
        regulatoryValidated: false,
        geometryValidated: false,
        ...(["published", "approved"].includes(caseRow.adminStatus)
          ? {
              adminStatus: "under_review",
              regulationStatus: caseRow.publishedRevisionId
                ? "published"
                : "draft",
            }
          : {}),
        updatedAt: new Date(c.recordedAt),
      })
      .where(
        and(
          eq(schema.regulationCases.id, c.caseId),
          eq(schema.regulationCases.currentRevisionId, c.baseRevisionId),
        ),
      );
    return { status: "applied" };
  }
  async decisions(
    tx: SnapshotTx,
    revisionId: string,
    state: RevisionShapeState,
  ) {
    const rows = await tx
      .select()
      .from(schema.regulationCaseValidations)
      .where(eq(schema.regulationCaseValidations.revisionId, revisionId))
      .orderBy(
        desc(
          sql`coalesce(${schema.regulationCaseValidations.commandSequence},0)`,
        ),
        desc(schema.regulationCaseValidations.recordedAt),
      );
    const legal = rows.find((r) => r.scope === "legal");
    const coverage = rows.find((r) => r.scope === "coverage");
    const shapes = new Map<string, (typeof rows)[number]>();
    for (const row of rows)
      if (row.scope === "shape" && row.shapeId && !shapes.has(row.shapeId))
        shapes.set(row.shapeId, row);
    const positive = new Map<string, string>();
    for (const [id, row] of shapes)
      if (row.validated && row.shapeHash) positive.set(id, row.shapeHash);
    return {
      legal,
      coverage,
      shapes,
      positive,
      coverageValidated:
        !!coverage?.validated &&
        coverage.coverageHash === state.coverage.coverageHash,
    };
  }
  private async validation(
    tx: SnapshotTx,
    c: CaseCommand,
    caseRow: typeof schema.regulationCases.$inferSelect,
    state: RevisionShapeState,
  ): Promise<SnapshotApplication> {
    const parsed = modeledValidationSchema.safeParse(c.data);
    if (!parsed.success) return refused("invalid validation schema");
    const v = parsed.data;
    if ((c.operation === "coverage-validation") !== (v.scope === "coverage"))
      return refused("coverage validation requires dedicated operation");
    if (
      v.scope === "coverage" &&
      (!c.actor.startsWith("admin:") ||
        v.coverageHash !== state.coverage.coverageHash ||
        (v.validated &&
          state.coverage.sourceAvailability !== "complete_snapshot"))
    )
      return refused("coverage confirmation identity or source unavailable");
    if (v.scope === "shape") {
      const shape = state.shapes.find((s) => s.id === v.shapeId);
      if (!shape || shape.shapeHash !== v.shapeHash)
        return refused("shape hash mismatch");
      if (
        v.validated &&
        (shape.status !== "proposed" ||
          shape.geojson === null ||
          shape.blockingReasons.length)
      )
        return refused("shape output unresolved");
      if (v.validated)
        await validateShapeTopology(tx, { ...state, shapes: [shape] });
    }
    await tx.insert(schema.regulationCaseValidations).values({
      id: v.validationId,
      caseId: c.caseId,
      revisionId: c.revisionId,
      scope: v.scope,
      shapeId: v.scope === "shape" ? v.shapeId : null,
      shapeHash: v.scope === "shape" ? v.shapeHash : null,
      coverageHash: v.scope === "coverage" ? v.coverageHash : null,
      validated: v.validated,
      note: v.note,
      actor: c.actor,
      recordedAt: new Date(c.recordedAt),
      commandSequence: c.sequence,
    });
    if (caseRow.currentRevisionId === c.revisionId) {
      const d = await this.decisions(tx, c.revisionId, state);
      const blockers = normalApprovalBlockers(
        state,
        !!d.legal?.validated,
        d.coverageValidated,
        d.positive,
      );
      await tx
        .update(schema.regulationCases)
        .set({
          regulatoryValidated: !!d.legal?.validated,
          geometryValidated: !blockers.missing.includes("shape"),
          updatedAt: new Date(c.recordedAt),
        })
        .where(eq(schema.regulationCases.id, c.caseId));
    }
    return { status: "applied" };
  }
  private async approval(
    tx: SnapshotTx,
    c: CaseCommand,
    caseRow: typeof schema.regulationCases.$inferSelect,
    state: RevisionShapeState,
  ): Promise<SnapshotApplication> {
    const parsed = modeledApprovalSchema.safeParse(c.data);
    if (!parsed.success) return refused("invalid approval schema");
    const a = parsed.data;
    const sourcePending = await pendingCaseInput(tx, caseRow, c.commandId);
    const d = await this.decisions(tx, c.revisionId, state);
    const blockers = normalApprovalBlockers(
      state,
      !!d.legal?.validated,
      d.coverageValidated,
      d.positive,
    );
    const reason = sourcePending
      ? "source or legacy mutation pending ordering"
      : caseRow.currentRevisionId !== c.revisionId ||
          c.baseRevisionId !== c.revisionId
        ? "stale revision"
        : a.shapeManifestHash !== state.shapeManifestHash
          ? "shape manifest mismatch"
          : !d.legal?.validated
            ? "legal validation missing"
            : a.metadataOnly &&
                blockers.missing.length &&
                !a.acknowledgeUnresolvedGeometry
              ? "unresolved geometry acknowledgement required"
              : !a.metadataOnly && blockers.missing.length
                ? `validation missing: ${blockers.missing.join(",")}`
                : null;
    let evidence: ApprovalEvidence | null = null;
    if (reason === null && d.legal) {
      evidence = a.metadataOnly
        ? {
            version: 1,
            kind: "metadata-only",
            shapeManifestHash: state.shapeManifestHash,
            legalValidationId: d.legal.id,
            acknowledgeUnresolvedGeometry: a.acknowledgeUnresolvedGeometry,
            unresolvedGeometry: blockers.missing.length > 0,
          }
        : {
            version: 1,
            kind: "drawable",
            shapeManifestHash: state.shapeManifestHash,
            legalValidationId: d.legal.id,
            coverageValidationId: d.coverage?.id ?? "",
            coverageHash: state.coverage.coverageHash,
            shapes: state.shapes
              .filter((s) => s.geojson !== null)
              .map((s) => ({
                shapeId: s.id,
                shapeHash: s.shapeHash,
                validationId: d.shapes.get(s.id)?.id ?? "",
              })),
          };
      verifyShapeCommand(() =>
        verifyApprovalEvidence(evidence, state, a.metadataOnly),
      );
    }
    await tx.insert(schema.regulationCaseApprovals).values({
      id: a.approvalId,
      caseId: c.caseId,
      revisionId: c.revisionId,
      metadataOnly: a.metadataOnly,
      note: a.note,
      actor: c.actor,
      recordedAt: new Date(c.recordedAt),
      applied: reason === null,
      refusalReason: reason,
      shapeManifestHash: a.shapeManifestHash,
      commandSequence: c.sequence,
      approvalEvidence: evidence,
    });
    if (reason) return refused(reason);
    await tx
      .update(schema.regulationCases)
      .set({
        adminStatus: "published",
        regulationStatus: "published",
        publishedRevisionId: c.revisionId,
        publishedMetadataOnly: a.metadataOnly,
        publishedApprovalId: a.approvalId,
        publishedToUsersAt: new Date(c.recordedAt),
        publishedToUsersBy: c.actor,
        lastVerifiedAt: new Date(c.recordedAt),
        updatedAt: new Date(c.recordedAt),
      })
      .where(
        and(
          eq(schema.regulationCases.id, c.caseId),
          eq(schema.regulationCases.currentRevisionId, c.revisionId),
        ),
      );
    return { status: "applied" };
  }
}
