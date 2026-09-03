import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { RawSyncCase } from "@/regulations/raw-fragment";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

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
   *
   * An explicit `caseKeys` list REPLACES the pending filter rather than
   * narrowing it: naming a case is already a human decision to spend, and it
   * is the only re-judge path — a case with an `ok` or `failed` verdict is
   * not pending, so ANDing the two would make the list select nothing.
   */
  async listPendingVerdicts(options: {
    limit: number;
    caseKeys?: string[];
  }): Promise<PendingVerdictCase[]> {
    const conditions =
      options.caseKeys && options.caseKeys.length > 0
        ? [inArray(schema.regulationCases.caseKey, options.caseKeys)]
        : [eq(schema.regulationCases.verdictStatus, "pending")];
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

/**
 * What the raw-corpus sync reads per case. The shape is DEFINED in
 * `raw-fragment.ts` (the pure module — the dependency stays repository →
 * domain) and only aliased here, so adding a column to the select without
 * teaching the fragment builder about it is a type error, not a field that
 * silently never renders.
 */
export type RawSyncCaseRow = RawSyncCase;

export class RegulationRawSyncRepository {
  constructor(private readonly db: Database) {}

  /** Most recently touched first — a bounded run refreshes what moved. */
  async listCases(limit: number): Promise<RawSyncCaseRow[]> {
    return await this.db
      .select({
        caseKey: schema.regulationCases.caseKey,
        title: schema.regulationCases.title,
        jurisdiction: schema.regulationCases.jurisdiction,
        sourceType: schema.regulationCases.sourceType,
        sourceRef: schema.regulationCases.sourceRef,
        sourceUrl: schema.regulationCases.sourceUrl,
        category: schema.regulationCases.category,
        summary: schema.regulationCases.summary,
        sourceStatus: schema.regulationCases.sourceStatus,
        changeType: schema.regulationCases.changeType,
        regulationStatus: schema.regulationCases.regulationStatus,
        adminStatus: schema.regulationCases.adminStatus,
        verdictStatus: schema.regulationCases.verdictStatus,
        effectiveFrom: schema.regulationCases.effectiveFrom,
        effectiveTo: schema.regulationCases.effectiveTo,
        currentRevisionId: schema.regulationCases.currentRevisionId,
        verdict: schema.regulationCaseRevisions.verdict,
        verdictRecordedAt: schema.regulationCaseRevisions.verdictRecordedAt,
      })
      .from(schema.regulationCases)
      .innerJoin(
        schema.regulationCaseRevisions,
        eq(
          schema.regulationCaseRevisions.id,
          schema.regulationCases.currentRevisionId,
        ),
      )
      .orderBy(desc(schema.regulationCases.updatedAt))
      .limit(limit);
  }

  async listGeometries(revisionId: string) {
    const rows = await this.db
      .select({
        position: schema.regulationCaseGeometries.position,
        name: schema.regulationCaseGeometries.name,
        kind: schema.regulationCaseGeometries.kind,
        season: schema.regulationCaseGeometries.season,
        points: schema.regulationCaseGeometries.points,
        geometrySource: schema.regulationCaseGeometries.geometrySource,
      })
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revisionId))
      .orderBy(asc(schema.regulationCaseGeometries.position));
    return rows.map((row) => ({
      ...row,
      // Written by the case projector as `[{lat, lon}]`; jsonb reads back
      // untyped.
      points: row.points as Array<{ lat: number; lon: number }>,
    }));
  }
}
