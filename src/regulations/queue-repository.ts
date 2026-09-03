import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

/** A case whose current revision still awaits its verdict, with everything
 * the verdict job needs to ask the question. */
export type PendingVerdictCase = {
  caseId: string;
  caseKey: string;
  title: string;
  jurisdiction: string;
  revisionId: string;
  contentHash: string | null;
  snapshotText: string | null;
  snapshotFragmentId: string | null;
};

export class RegulationQueueRepository {
  constructor(private readonly db: Database) {}

  /**
   * Oldest first — a case that has waited longest for its verdict is served
   * first, so a bounded run makes monotone progress across the queue instead
   * of re-judging whatever happens to sort on top.
   */
  async listPendingVerdicts(options: {
    limit: number;
    caseKeys?: string[];
  }): Promise<PendingVerdictCase[]> {
    const conditions = [eq(schema.regulationCases.verdictStatus, "pending")];
    if (options.caseKeys && options.caseKeys.length > 0) {
      conditions.push(
        inArray(schema.regulationCases.caseKey, options.caseKeys),
      );
    }
    const rows = await this.db
      .select({
        caseId: schema.regulationCases.id,
        caseKey: schema.regulationCases.caseKey,
        title: schema.regulationCases.title,
        jurisdiction: schema.regulationCases.jurisdiction,
        revisionId: schema.regulationCaseRevisions.id,
        contentHash: schema.regulationCaseRevisions.contentHash,
        snapshotText: schema.regulationCaseRevisions.snapshotText,
        snapshotFragmentId: schema.regulationCaseRevisions.snapshotFragmentId,
      })
      .from(schema.regulationCases)
      .innerJoin(
        schema.regulationCaseRevisions,
        eq(
          schema.regulationCaseRevisions.id,
          schema.regulationCases.currentRevisionId,
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(schema.regulationCases.firstSeenAt))
      .limit(options.limit);
    return rows;
  }
}
