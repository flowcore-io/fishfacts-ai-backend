import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { RegulationCaseNoteRecorded } from "@/events/contracts";

/**
 * Projects `regulation.case.note.recorded.0` into `regulation_case_notes` —
 * one row per note, and nothing else. No case column is touched: writing a
 * note must not be able to move a case's status, validation flags or
 * published pointer, and the cheapest way to guarantee that is a projector
 * that cannot express it.
 *
 * Unlike the action projector there is no case-existence check. The note
 * table holds no foreign key (events arrive in stream order, but a replay
 * may re-land a note before its case), so an early note inserts and the
 * detail read finds it once the case catches up; dropping it would lose an
 * admin's words for good.
 */
export class RegulationCaseNoteProjector {
  constructor(private readonly db: Database) {}

  async handleRecorded(payload: RegulationCaseNoteRecorded): Promise<void> {
    // Keyed on the event's noteId: a redelivery re-lands as a no-op rather
    // than doubling the note. Append-only, so there is nothing to update.
    await this.db
      .insert(schema.regulationCaseNotes)
      .values({
        noteId: payload.noteId,
        caseId: payload.caseId,
        caseKey: payload.caseKey,
        text: payload.text,
        actor: payload.actor,
        recordedAt: new Date(payload.recordedAt),
      })
      .onConflictDoNothing();
  }
}
