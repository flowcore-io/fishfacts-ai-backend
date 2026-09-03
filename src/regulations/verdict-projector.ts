import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { RegulationVerdictRecorded } from "@/events/contracts";
import { and, eq } from "drizzle-orm";
import { verdictConfidenceOf } from "./verdict";

/**
 * Lands a recorded verdict on the revision it judged, and mirrors the status
 * onto the case ONLY while that revision is still current — a verdict that
 * arrives after the text moved on is history, not state, and must not
 * overwrite the newer revision's `pending`.
 */
export class RegulationVerdictProjector {
  constructor(private readonly db: Database) {}

  async handleRecorded(payload: RegulationVerdictRecorded): Promise<void> {
    const confidence =
      payload.status === "ok" ? verdictConfidenceOf(payload.issues) : null;
    const recordedAt = new Date(payload.recordedAt);

    const updated = await this.db
      .update(schema.regulationCaseRevisions)
      .set({
        verdictStatus: payload.status,
        verdict: payload.status === "ok" ? payload.issues : null,
        verdictModel: payload.model,
        verdictConfidence: confidence,
        verdictRecordedAt: recordedAt,
        ...(payload.status === "failed" && payload.error
          ? { parseError: payload.error }
          : {}),
      })
      .where(eq(schema.regulationCaseRevisions.id, payload.revisionId))
      .returning({ caseId: schema.regulationCaseRevisions.caseId });

    const caseId = updated[0]?.caseId;
    if (!caseId) {
      // A verdict for a revision the projection has never seen — the event
      // stream will deliver the observation eventually; this verdict re-lands
      // on replay. Logged, not thrown: one stray event must not stall the pump.
      console.warn("[RegulationVerdict] no such revision", {
        revisionId: payload.revisionId,
        caseKey: payload.caseKey,
      });
      return;
    }

    await this.db
      .update(schema.regulationCases)
      .set({ verdictStatus: payload.status })
      .where(
        and(
          eq(schema.regulationCases.id, caseId),
          eq(schema.regulationCases.currentRevisionId, payload.revisionId),
        ),
      );
  }
}
