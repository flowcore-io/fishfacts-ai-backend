import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type {
  RegulationAdminAction,
  RegulationAdminActionRecorded,
} from "@/events/contracts";
import { and, eq } from "drizzle-orm";

/**
 * Projects `regulation.case.admin-action.recorded.0` twice over: an
 * append-only row in `regulation_case_actions` (the audit trail the detail
 * screen lists) and the action's effect on the case row. Events arrive in
 * stream order, so last-write-wins on the case columns is the correct
 * semantics for admin acts; the log row keys on the event's actionId, so a
 * replay re-lands identically instead of doubling the trail.
 */
export class RegulationCaseActionProjector {
  constructor(private readonly db: Database) {}

  async handleRecorded(payload: RegulationAdminActionRecorded): Promise<void> {
    // One transaction for the log row AND the case effect: if the effect
    // fails after the row committed, redelivery would hit the dedup conflict
    // and skip the effect forever — the trail claiming an action the case
    // never reflects. Atomic, both re-land together on redelivery, which is
    // what makes the onConflictDoNothing dedup safe to rely on at all.
    await this.db.transaction(async (tx) => {
      // Existence first, before anything is written: an action for a case
      // the projection has never seen must commit NOTHING — a log row
      // without its effect is exactly the trail/state disagreement this
      // projector exists to prevent. Logged, not thrown: one stray event
      // must not stall the pump; a full replay re-lands it in order.
      const [caseRow] = await tx
        .select({ id: schema.regulationCases.id })
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, payload.caseId))
        .limit(1);
      if (!caseRow) {
        console.warn("[RegulationAction] no such case", {
          caseId: payload.caseId,
          caseKey: payload.caseKey,
          kind: payload.action.kind,
        });
        return;
      }

      const inserted = await tx
        .insert(schema.regulationCaseActions)
        .values({
          id: payload.actionId,
          caseId: payload.caseId,
          kind: payload.action.kind,
          action: payload.action,
          actor: payload.actor,
          recordedAt: new Date(payload.recordedAt),
        })
        .onConflictDoNothing()
        .returning({ id: schema.regulationCaseActions.id });
      if (inserted.length === 0) {
        // Redelivery of an action already fully projected — the case effect
        // committed with this row; running it again out of order could
        // resurrect a value a LATER action replaced.
        return;
      }

      const effect = caseEffectOf(payload.action);
      if (effect) {
        await tx
          .update(schema.regulationCases)
          .set({ ...effect, updatedAt: new Date(payload.recordedAt) })
          .where(eq(schema.regulationCases.id, payload.caseId));
      }

      // Reading a case for the first time moves it out of the `unread` inbox
      // status — the only implicit transition here. Un-reading deliberately
      // does not move it back: the case HAS been reviewed once, and §12's
      // prominence-after-read is carried by is_read/urgency, not the status.
      if (payload.action.kind === "mark_read" && payload.action.read) {
        await tx
          .update(schema.regulationCases)
          .set({ adminStatus: "under_review" })
          .where(
            and(
              eq(schema.regulationCases.id, payload.caseId),
              eq(schema.regulationCases.adminStatus, "unread"),
            ),
          );
      }
    });
  }
}

/** The columns an action writes on the case row; null = log-only action. */
function caseEffectOf(
  action: RegulationAdminAction,
): Partial<typeof schema.regulationCases.$inferInsert> | null {
  switch (action.kind) {
    case "mark_read":
      return { isRead: action.read };
    case "assign":
      return { assignee: action.assignee };
    case "set_urgency":
      return { urgency: action.urgency };
    case "snooze":
      return { snoozeUntil: action.until ? new Date(action.until) : null };
    case "request_information":
      // The note lives on the action row; the case only changes lane.
      return { adminStatus: "awaiting_information" };
    case "reject":
      return { adminStatus: "rejected" };
    case "mark_duplicate":
      return {
        adminStatus: "duplicate",
        duplicateOfCaseId: action.duplicateOfCaseId,
      };
  }
}
