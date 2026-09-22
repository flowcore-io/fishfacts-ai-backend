import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type {
  RegulationRevisionFields,
  RegulationRevisionGeometry,
} from "@/events/contracts";
import type { RawSyncCase } from "@/regulations/raw-fragment";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { editableFieldsOfCase, snapshotOnlyFieldsOf } from "./revision-fields";

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

/** A case awaiting an applicability, with everything the extraction job
 * needs both to ask the question and to build a self-contained revision
 * proposal out of the answer. */
export type ApplicabilityCandidateCase = {
  caseId: string;
  caseKey: string;
  title: string;
  jurisdiction: string;
  currentRevisionId: string;
  snapshotText: string | null;
  snapshotFragmentId: string | null;
  /** The base revision's complete field snapshot — a revision event carries
   * the whole resulting state, so the proposal is this with `applicability`
   * replaced. */
  fields: RegulationRevisionFields;
};

export class RegulationQueueRepository {
  constructor(private readonly db: Database) {}

  /**
   * Cases with no applicability yet, in the order Johann asked for: the
   * PUBLISHED cases first (they are what the 1st mate is answering from
   * today, so a wrong scope there is the one that reaches a fisherman),
   * then the FAROESE cases (the home water), then the rest — oldest first
   * inside each band, so a bounded run makes monotone progress instead of
   * re-reading whatever sorts on top.
   *
   * An explicit `caseKeys` list REPLACES the filter rather than narrowing
   * it, exactly as in `listPendingVerdicts`: naming a case is already a
   * human decision to spend, and it is the only RE-extraction path — a case
   * that already has an applicability is not a candidate, so ANDing the two
   * would select nothing. A named list is never truncated by `limit` either.
   */
  async listApplicabilityCandidates(options: {
    limit: number;
    caseKeys?: string[];
  }): Promise<ApplicabilityCandidateCase[]> {
    const named = options.caseKeys ?? [];
    const condition =
      named.length > 0
        ? inArray(schema.regulationCases.caseKey, named)
        : isNull(schema.regulationCases.applicability);
    // A named list is a human asking for exactly those cases; silently
    // dropping the tail of it past the default limit would look like the
    // extraction skipped them. The limit still bounds the unnamed backfill,
    // which is where it earns its keep.
    const limit = Math.max(options.limit, named.length);
    const rows = await this.db
      .select({
        caseId: schema.regulationCases.id,
        caseKey: schema.regulationCases.caseKey,
        jurisdiction: schema.regulationCases.jurisdiction,
        currentRevisionId: schema.regulationCases.currentRevisionId,
        snapshotText: schema.regulationCaseRevisions.snapshotText,
        snapshotFragmentId: schema.regulationCaseRevisions.snapshotFragmentId,
        // The snapshot-only fields (`displayName`) live nowhere else, and
        // the proposal built from this row carries the WHOLE field set.
        revisionFields: schema.regulationCaseRevisions.fields,
        title: schema.regulationCases.title,
        authority: schema.regulationCases.authority,
        regulationNumber: schema.regulationCases.regulationNumber,
        category: schema.regulationCases.category,
        summary: schema.regulationCases.summary,
        effectiveFrom: schema.regulationCases.effectiveFrom,
        effectiveTo: schema.regulationCases.effectiveTo,
        expiresAt: schema.regulationCases.expiresAt,
        seasonalRecurrence: schema.regulationCases.seasonalRecurrence,
        interpretationNotes: schema.regulationCases.interpretationNotes,
        applicability: schema.regulationCases.applicability,
      })
      .from(schema.regulationCases)
      .innerJoin(
        schema.regulationCaseRevisions,
        eq(
          schema.regulationCaseRevisions.id,
          schema.regulationCases.currentRevisionId,
        ),
      )
      .where(condition)
      .orderBy(
        sql`(${schema.regulationCases.publishedRevisionId} is not null) desc`,
        sql`(${schema.regulationCases.jurisdiction} = 'FO') desc`,
        asc(schema.regulationCases.firstSeenAt),
      )
      .limit(limit);

    return rows.map((row) => ({
      caseId: row.caseId,
      caseKey: row.caseKey,
      title: row.title,
      jurisdiction: row.jurisdiction,
      currentRevisionId: row.currentRevisionId,
      snapshotText: row.snapshotText,
      snapshotFragmentId: row.snapshotFragmentId,
      fields: editableFieldsOfCase(
        row,
        snapshotOnlyFieldsOf(row.revisionFields),
      ),
    }));
  }

  /**
   * The base revision's areas in the EVENT shape, so a proposal that touches
   * no geometry still carries the complete resulting area set (revision
   * events are snapshots, never deltas — an omitted area would read as a
   * deleted one).
   */
  async listRevisionGeometries(
    revisionId: string,
  ): Promise<RegulationRevisionGeometry[]> {
    const rows = await this.db
      .select({
        name: schema.regulationCaseGeometries.name,
        section: schema.regulationCaseGeometries.section,
        kind: schema.regulationCaseGeometries.kind,
        season: schema.regulationCaseGeometries.season,
        verticesQuoted: schema.regulationCaseGeometries.verticesQuoted,
        points: schema.regulationCaseGeometries.points,
        geometrySource: schema.regulationCaseGeometries.geometrySource,
        coordinateSystem: schema.regulationCaseGeometries.coordinateSystem,
        precision: schema.regulationCaseGeometries.precision,
      })
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revisionId))
      .orderBy(asc(schema.regulationCaseGeometries.position));
    return rows.map((row) => ({
      ...row,
      kind: row.kind as RegulationRevisionGeometry["kind"],
      verticesQuoted: row.verticesQuoted as string[] | null,
      points: row.points as RegulationRevisionGeometry["points"],
      geometrySource:
        row.geometrySource as RegulationRevisionGeometry["geometrySource"],
    }));
  }

  /** The case's current-revision pointer as it stands NOW — how a writer
   * confirms its proposal actually landed rather than losing a race. */
  async getCurrentRevisionId(caseId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ currentRevisionId: schema.regulationCases.currentRevisionId })
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, caseId))
      .limit(1);
    return row?.currentRevisionId ?? null;
  }

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
