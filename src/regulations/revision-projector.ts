import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type {
  RegulationApprovalRecorded,
  RegulationRevisionPointerMoved,
  RegulationRevisionProposed,
  RegulationValidationRecorded,
} from "@/events/contracts";
import { pointsToMultipointWkt } from "@/jmelding/geo-parser";
import { and, desc, eq, sql } from "drizzle-orm";
import { geometryIdFor } from "./ids";
import { caseColumnsOfFields } from "./revision-fields";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The case columns of the flag computation — `geometryCount` feeds the lane
 * decision and must not reach the UPDATE. */
function stripGeometryCount(flags: {
  regulatoryValidated: boolean;
  geometryValidated: boolean;
  geometryCount: number;
}): { regulatoryValidated: boolean; geometryValidated: boolean } {
  return {
    regulatoryValidated: flags.regulatoryValidated,
    geometryValidated: flags.geometryValidated,
  };
}

/** The inbox lanes a validation may steer between. Terminal and pre-review
 * lanes are never dragged around by a validation landing. */
const STEERABLE_LANES = [
  "under_review",
  "awaiting_information",
  "awaiting_regulatory_validation",
  "awaiting_geometry_validation",
];

/**
 * Projects the stage ② B3 events: proposed revisions, pointer moves
 * (undo/redo), the two validation scopes, and approvals. Everything runs in
 * one transaction per event (the #171 lesson: a log row and its effect
 * commit together or not at all), checks existence before writing, and
 * de-duplicates on the event's own id so redelivery is a no-op.
 */
export class RegulationRevisionProjector {
  constructor(private readonly db: Database) {}

  async handleProposed(payload: RegulationRevisionProposed): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: schema.regulationCaseRevisions.id })
        .from(schema.regulationCaseRevisions)
        .where(eq(schema.regulationCaseRevisions.id, payload.revisionId))
        .limit(1);
      if (existing.length > 0) return; // redelivery, fully projected

      const [caseRow] = await tx
        .select({
          id: schema.regulationCases.id,
          currentRevisionId: schema.regulationCases.currentRevisionId,
          adminStatus: schema.regulationCases.adminStatus,
        })
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, payload.caseId))
        .limit(1);
      if (!caseRow) {
        console.warn("[RegulationRevision] no such case", {
          caseId: payload.caseId,
          caseKey: payload.caseKey,
        });
        return;
      }
      // The edit-after-source-change race, decided by stream order: a draft
      // built against a base that is no longer current (a collector revision
      // or another redraft landed first) must not overwrite the newer state.
      // The route already refused the obvious case; this catches the write
      // that was in flight when the base moved.
      if (caseRow.currentRevisionId !== payload.baseRevisionId) {
        console.warn("[RegulationRevision] stale base, draft not landed", {
          caseId: payload.caseId,
          baseRevisionId: payload.baseRevisionId,
          currentRevisionId: caseRow.currentRevisionId,
        });
        return;
      }

      const [base] = await tx
        .select()
        .from(schema.regulationCaseRevisions)
        .where(eq(schema.regulationCaseRevisions.id, payload.baseRevisionId))
        .limit(1);
      if (!base) {
        console.warn("[RegulationRevision] base revision missing", {
          baseRevisionId: payload.baseRevisionId,
        });
        return;
      }
      const positionRows = await tx
        .select({
          max: sql<
            number | null
          >`max(${schema.regulationCaseRevisions.position})`,
        })
        .from(schema.regulationCaseRevisions)
        .where(eq(schema.regulationCaseRevisions.caseId, payload.caseId));
      const position = (positionRows[0]?.max ?? -1) + 1;

      // The snapshot and its verdict carry over verbatim: a redraft changes
      // the INTERPRETATION, never the source text, and the verdict judged
      // the text.
      await tx.insert(schema.regulationCaseRevisions).values({
        id: payload.revisionId,
        caseId: payload.caseId,
        position,
        contentHash: base.contentHash,
        changeType: base.changeType,
        author: payload.actor,
        snapshotText: base.snapshotText,
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
        sourceEventSignature: `revision-proposed:${payload.revisionId}`,
        baseRevisionId: payload.baseRevisionId,
        changes: payload.changes,
        fields: payload.fields,
      });

      for (const [index, area] of payload.geometries.entries()) {
        const wkt = pointsToMultipointWkt(area.points);
        await tx.insert(schema.regulationCaseGeometries).values({
          id: geometryIdFor(payload.revisionId, index),
          caseId: payload.caseId,
          revisionId: payload.revisionId,
          position: index,
          name: area.name,
          section: area.section,
          kind: area.kind,
          season: area.season,
          verticesQuoted: area.verticesQuoted,
          points: area.points,
          geom: wkt ? (sql`ST_GeomFromText(${wkt}, 4326)` as never) : null,
          geometrySource: area.geometrySource,
          coordinateSystem: area.coordinateSystem,
          precision: area.precision,
          // A redrafted area is a NEW area: validation names geometry ids,
          // and this id did not exist when any earlier validation happened.
          geometryValidated: false,
        });
      }

      await tx
        .update(schema.regulationCases)
        .set({
          ...caseColumnsOfFields(payload.fields),
          currentRevisionId: payload.revisionId,
          // A new draft invalidates both validations — they are statements
          // about a revision, and this is a different revision.
          regulatoryValidated: false,
          geometryValidated: false,
          // An approved case whose draft moves is no longer approved: the
          // approval named a revision that is no longer current. The
          // approval row keeps what was approved; the case state must not
          // keep claiming it. (Published is stage ③'s to rule on.)
          ...(caseRow.adminStatus === "approved"
            ? {
                adminStatus: "under_review",
                regulationStatus: "draft",
              }
            : {}),
          updatedAt: new Date(payload.recordedAt),
        })
        .where(eq(schema.regulationCases.id, payload.caseId));
    });
  }

  async handlePointerMoved(
    payload: RegulationRevisionPointerMoved,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(schema.regulationCaseRevisions)
        .where(
          and(
            eq(schema.regulationCaseRevisions.id, payload.toRevisionId),
            eq(schema.regulationCaseRevisions.caseId, payload.caseId),
          ),
        )
        .limit(1);
      if (!target) {
        console.warn("[RegulationRevision] pointer target missing", {
          caseId: payload.caseId,
          toRevisionId: payload.toRevisionId,
        });
        return;
      }
      // The move is also an audit-trail entry; its row doubles as the
      // redelivery guard.
      const inserted = await tx
        .insert(schema.regulationCaseActions)
        .values({
          id: payload.pointerMoveId,
          caseId: payload.caseId,
          kind: "revision_pointer_moved",
          action: {
            kind: "revision_pointer_moved",
            toRevisionId: payload.toRevisionId,
          },
          actor: payload.actor,
          recordedAt: new Date(payload.recordedAt),
        })
        .onConflictDoNothing()
        .returning({ id: schema.regulationCaseActions.id });
      if (inserted.length === 0) return;

      const [pointerCase] = await tx
        .select({
          adminStatus: schema.regulationCases.adminStatus,
          currentRevisionId: schema.regulationCases.currentRevisionId,
        })
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, payload.caseId))
        .limit(1);
      // Same demotion rule as a proposed draft: undo AWAY from the approved
      // revision un-approves the case (a no-op move to the same revision
      // does not). The approval row keeps what was approved.
      const leavesApprovedRevision =
        pointerCase?.adminStatus === "approved" &&
        pointerCase.currentRevisionId !== target.id;
      await tx
        .update(schema.regulationCases)
        .set({
          currentRevisionId: target.id,
          ...(leavesApprovedRevision
            ? { adminStatus: "under_review", regulationStatus: "draft" }
            : {}),
          // Restore what the target revision knew about itself. Pre-B3
          // collector revisions have no fields snapshot; their geometry set
          // and verdict still restore, the field columns stay put.
          ...(target.fields
            ? caseColumnsOfFields(
                target.fields as Parameters<typeof caseColumnsOfFields>[0],
              )
            : {}),
          verdictStatus: target.verdictStatus,
          ...stripGeometryCount(await this.validationFlagsOf(tx, target.id)),
          updatedAt: new Date(payload.recordedAt),
        })
        .where(eq(schema.regulationCases.id, payload.caseId));
    });
  }

  async handleValidationRecorded(
    payload: RegulationValidationRecorded,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [revision] = await tx
        .select({ id: schema.regulationCaseRevisions.id })
        .from(schema.regulationCaseRevisions)
        .where(
          and(
            eq(schema.regulationCaseRevisions.id, payload.revisionId),
            eq(schema.regulationCaseRevisions.caseId, payload.caseId),
          ),
        )
        .limit(1);
      if (!revision) {
        console.warn("[RegulationRevision] validation target missing", {
          caseId: payload.caseId,
          revisionId: payload.revisionId,
        });
        return;
      }
      const inserted = await tx
        .insert(schema.regulationCaseValidations)
        .values({
          id: payload.validationId,
          caseId: payload.caseId,
          revisionId: payload.revisionId,
          scope: payload.scope,
          geometryId: payload.geometryId,
          validated: payload.validated,
          note: payload.note,
          actor: payload.actor,
          recordedAt: new Date(payload.recordedAt),
        })
        .onConflictDoNothing()
        .returning({ id: schema.regulationCaseValidations.id });
      if (inserted.length === 0) return;

      if (payload.scope === "geometry" && payload.geometryId) {
        await tx
          .update(schema.regulationCaseGeometries)
          .set({ geometryValidated: payload.validated })
          .where(
            and(
              eq(schema.regulationCaseGeometries.id, payload.geometryId),
              eq(
                schema.regulationCaseGeometries.revisionId,
                payload.revisionId,
              ),
            ),
          );
      }

      // The case flags summarise the CURRENT revision only; a validation of
      // a superseded revision is history, not state.
      const [caseRow] = await tx
        .select({
          currentRevisionId: schema.regulationCases.currentRevisionId,
          adminStatus: schema.regulationCases.adminStatus,
        })
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, payload.caseId))
        .limit(1);
      if (!caseRow || caseRow.currentRevisionId !== payload.revisionId) return;

      const flags = await this.validationFlagsOf(tx, payload.revisionId);
      const lane = STEERABLE_LANES.includes(caseRow.adminStatus)
        ? laneOf(flags, caseRow.adminStatus)
        : caseRow.adminStatus;
      const { geometryCount: _count, ...caseFlags } = flags;
      await tx
        .update(schema.regulationCases)
        .set({
          ...caseFlags,
          adminStatus: lane,
          ...(payload.scope === "legal" && payload.validated
            ? { lastVerifiedAt: new Date(payload.recordedAt) }
            : {}),
          updatedAt: new Date(payload.recordedAt),
        })
        .where(eq(schema.regulationCases.id, payload.caseId));
    });
  }

  async handleApprovalRecorded(
    payload: RegulationApprovalRecorded,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [caseRow] = await tx
        .select({
          id: schema.regulationCases.id,
          currentRevisionId: schema.regulationCases.currentRevisionId,
          regulatoryValidated: schema.regulationCases.regulatoryValidated,
          geometryValidated: schema.regulationCases.geometryValidated,
        })
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, payload.caseId))
        .limit(1);
      if (!caseRow) {
        console.warn("[RegulationRevision] approval for unknown case", {
          caseId: payload.caseId,
          caseKey: payload.caseKey,
        });
        return;
      }

      // The route made these same checks and refused synchronously with the
      // diff; here they run again under stream order, because a revision may
      // have landed between the route's read and this projection. A refusal
      // is RECORDED, not dropped — the audit trail keeps the race losers.
      const refusalReason =
        caseRow.currentRevisionId !== payload.revisionId
          ? `stale revision: current is ${caseRow.currentRevisionId}`
          : !caseRow.regulatoryValidated
            ? "legal validation missing"
            : !payload.metadataOnly && !caseRow.geometryValidated
              ? "geometry validation missing"
              : null;

      const inserted = await tx
        .insert(schema.regulationCaseApprovals)
        .values({
          id: payload.approvalId,
          caseId: payload.caseId,
          revisionId: payload.revisionId,
          metadataOnly: payload.metadataOnly,
          note: payload.note,
          actor: payload.actor,
          recordedAt: new Date(payload.recordedAt),
          applied: refusalReason === null,
          refusalReason,
        })
        .onConflictDoNothing()
        .returning({ id: schema.regulationCaseApprovals.id });
      if (inserted.length === 0) return;
      if (refusalReason !== null) {
        console.warn("[RegulationRevision] approval refused at projection", {
          caseId: payload.caseId,
          revisionId: payload.revisionId,
          refusalReason,
        });
        return;
      }

      await tx
        .update(schema.regulationCases)
        .set({
          adminStatus: "approved",
          regulationStatus: "validated",
          lastVerifiedAt: new Date(payload.recordedAt),
          updatedAt: new Date(payload.recordedAt),
        })
        .where(eq(schema.regulationCases.id, payload.caseId));
    });
  }

  /** What the two case flags should say for a given revision: the latest
   * legal validation verdict, and whether every one of its areas (at least
   * one existing) is validated. */
  private async validationFlagsOf(
    tx: Tx,
    revisionId: string,
  ): Promise<{
    regulatoryValidated: boolean;
    geometryValidated: boolean;
    geometryCount: number;
  }> {
    const [latestLegal] = await tx
      .select({ validated: schema.regulationCaseValidations.validated })
      .from(schema.regulationCaseValidations)
      .where(
        and(
          eq(schema.regulationCaseValidations.revisionId, revisionId),
          eq(schema.regulationCaseValidations.scope, "legal"),
        ),
      )
      .orderBy(desc(schema.regulationCaseValidations.recordedAt))
      .limit(1);
    const [geometryTotals] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        validated: sql<number>`count(*) filter (where ${schema.regulationCaseGeometries.geometryValidated})::int`,
      })
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revisionId));
    const total = geometryTotals?.total ?? 0;
    return {
      regulatoryValidated: latestLegal?.validated ?? false,
      // Zero areas is NOT vacuous validation: a text-only statute and a
      // parse that silently dropped its areas look identical at zero rows,
      // and only a human can tell them apart — that is what the approval's
      // explicit metadataOnly acknowledgment is for.
      geometryValidated: total > 0 && geometryTotals?.validated === total,
      geometryCount: total,
    };
  }
}

/** Steer the inbox lane toward whichever validation is still missing; leave
 * it alone once both hold (approval is the next move, and it sets its own).
 * A case with no areas at all is never steered toward geometry validation —
 * that lane would be a dead end with nothing in it to validate; its exit is
 * the approval's explicit metadataOnly acknowledgment. */
function laneOf(
  flags: {
    regulatoryValidated: boolean;
    geometryValidated: boolean;
    geometryCount: number;
  },
  current: string,
): string {
  if (
    flags.regulatoryValidated &&
    !flags.geometryValidated &&
    flags.geometryCount > 0
  ) {
    return "awaiting_geometry_validation";
  }
  if (!flags.regulatoryValidated && flags.geometryValidated) {
    return "awaiting_regulatory_validation";
  }
  return current;
}
