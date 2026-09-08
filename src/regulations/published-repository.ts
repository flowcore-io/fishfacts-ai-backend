import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { RegulationRevisionFields } from "@/events/contracts";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

/**
 * Read side of the PUBLISHED lane (stage ③) — what the user-facing 1st mate
 * lists and draws. Non-admin by design: every other regulations read is
 * ADMIN-gated because it exposes the review queue; this one serves only
 * cases a human approved, and only the revision the approval pinned.
 *
 * The pinned revision is the source of every field users see. The CASE
 * columns follow the current (draft) revision, so a redraft in progress
 * would leak unapproved edits if this read used them; the published
 * revision's `fields` snapshot is what was approved. Revisions from before
 * the snapshot existed (pre-#172 collectors) have no `fields` — for those
 * the case columns are the only record and are used as they stand.
 */

export type PublishedRegulationGeometry = {
  id: string;
  position: number;
  name: string | null;
  section: string | null;
  kind: string;
  season: string | null;
  /** The vertex SET as parsed, in source order — never a derived polygon. */
  points: Array<{ lat: number; lon: number }>;
  geometrySource: string;
  coordinateSystem: string;
  precision: string | null;
};

export type PublishedRegulation = {
  id: string;
  caseKey: string;
  jurisdiction: string;
  sourceType: string;
  sourceUrl: string;
  title: string;
  authority: string | null;
  regulationNumber: string | null;
  category: string | null;
  summary: string | null;
  applicability: unknown;
  seasonalRecurrence: string | null;
  interpretationNotes: string | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  expiresAt: Date | null;
  /** When the SOURCE published the regulation (its own date, may be null). */
  sourcePublishedAt: Date | null;
  /** When an admin approved & published it to users, and the revision pinned. */
  publishedAt: Date | null;
  publishedRevisionId: string;
  /** Approved on legal validation alone — no geometry exists BY DESIGN;
   * an empty area list here is not a parse failure. */
  metadataOnly: boolean;
  /** Computed from the validity window at read time. */
  inForce: "current" | "upcoming" | "expired";
  geometries: PublishedRegulationGeometry[];
};

export type PublishedListFilters = {
  jurisdiction?: string[];
  /** `current` = in force right now (the default consumers want);
   * `all` includes upcoming and expired. */
  status: "current" | "all";
  limit: number;
  offset: number;
};

export class RegulationPublishedReadRepository {
  constructor(private readonly db: Database) {}

  /**
   * The published set is small by construction (each entry cost a human
   * approval), so the window filter runs here rather than in SQL: it has to
   * apply to the PINNED revision's dates, which live in the `fields`
   * snapshot, not on the case columns a draft may have moved.
   */
  async listPublished(
    filters: PublishedListFilters,
  ): Promise<{ regulations: PublishedRegulation[]; total: number }> {
    const conditions = [isNotNull(schema.regulationCases.publishedRevisionId)];
    if (filters.jurisdiction && filters.jurisdiction.length > 0) {
      conditions.push(
        inArray(schema.regulationCases.jurisdiction, filters.jurisdiction),
      );
    }
    const cases = await this.db
      .select()
      .from(schema.regulationCases)
      .where(and(...conditions))
      .orderBy(
        desc(schema.regulationCases.publishedToUsersAt),
        asc(schema.regulationCases.id),
      );
    const resolved = await this.resolve(cases);
    const matching =
      filters.status === "current"
        ? resolved.filter((item) => item.inForce === "current")
        : resolved;
    return {
      regulations: matching.slice(
        filters.offset,
        filters.offset + filters.limit,
      ),
      total: matching.length,
    };
  }

  /** The published-sync job's reconciliation read — no route serves this.
   * Cases that HAVE been published (an applied approval exists) but are not
   * published now: a decline cleared the pin, so their corpus fragments
   * must leave the collection. */
  async listWithdrawn(): Promise<Array<{ caseKey: string; title: string }>> {
    return await this.db
      .selectDistinct({
        caseKey: schema.regulationCases.caseKey,
        title: schema.regulationCases.title,
      })
      .from(schema.regulationCases)
      .innerJoin(
        schema.regulationCaseApprovals,
        and(
          eq(
            schema.regulationCaseApprovals.caseId,
            schema.regulationCases.id,
          ),
          eq(schema.regulationCaseApprovals.applied, true),
        ),
      )
      .where(isNull(schema.regulationCases.publishedRevisionId));
  }

  async getPublished(caseId: string): Promise<PublishedRegulation | null> {
    const [caseRow] = await this.db
      .select()
      .from(schema.regulationCases)
      .where(
        and(
          eq(schema.regulationCases.id, caseId),
          isNotNull(schema.regulationCases.publishedRevisionId),
        ),
      )
      .limit(1);
    if (!caseRow) return null;
    const [resolved] = await this.resolve([caseRow]);
    return resolved ?? null;
  }

  private async resolve(
    cases: Array<typeof schema.regulationCases.$inferSelect>,
  ): Promise<PublishedRegulation[]> {
    if (cases.length === 0) return [];
    const revisionIds = cases.map(
      (row) => row.publishedRevisionId as string, // isNotNull-filtered above
    );
    const [revisions, geometries] = await Promise.all([
      this.db
        .select({
          id: schema.regulationCaseRevisions.id,
          fields: schema.regulationCaseRevisions.fields,
        })
        .from(schema.regulationCaseRevisions)
        .where(inArray(schema.regulationCaseRevisions.id, revisionIds)),
      this.db
        .select({
          id: schema.regulationCaseGeometries.id,
          revisionId: schema.regulationCaseGeometries.revisionId,
          position: schema.regulationCaseGeometries.position,
          name: schema.regulationCaseGeometries.name,
          section: schema.regulationCaseGeometries.section,
          kind: schema.regulationCaseGeometries.kind,
          season: schema.regulationCaseGeometries.season,
          points: schema.regulationCaseGeometries.points,
          geometrySource: schema.regulationCaseGeometries.geometrySource,
          coordinateSystem: schema.regulationCaseGeometries.coordinateSystem,
          precision: schema.regulationCaseGeometries.precision,
        })
        .from(schema.regulationCaseGeometries)
        .where(inArray(schema.regulationCaseGeometries.revisionId, revisionIds))
        .orderBy(asc(schema.regulationCaseGeometries.position)),
    ]);
    const fieldsByRevision = new Map(
      revisions.map((revision) => [revision.id, revision.fields]),
    );
    const geometriesByRevision = new Map<
      string,
      PublishedRegulationGeometry[]
    >();
    for (const geometry of geometries) {
      const { revisionId, ...area } = geometry;
      const list = geometriesByRevision.get(revisionId) ?? [];
      list.push({
        ...area,
        points: area.points as Array<{ lat: number; lon: number }>,
      });
      geometriesByRevision.set(revisionId, list);
    }
    return cases.map((caseRow) => {
      const revisionId = caseRow.publishedRevisionId as string;
      const fields = fieldsByRevision.get(revisionId) as
        | RegulationRevisionFields
        | null
        | undefined;
      // Same whole-snapshot gate as the scalar fields below: when a snapshot
      // exists, EVERY value comes from it — a missing date key reads as null,
      // never as "fall back to the case column", because the case column is
      // the in-progress draft and that fallback would be exactly the leak
      // the pinned-revision design exists to prevent.
      const effectiveFrom = fields
        ? dateOrNull(fields.effectiveFrom)
        : caseRow.effectiveFrom;
      const effectiveTo = fields
        ? dateOrNull(fields.effectiveTo)
        : caseRow.effectiveTo;
      const expiresAt = fields
        ? dateOrNull(fields.expiresAt)
        : caseRow.expiresAt;
      return {
        id: caseRow.id,
        caseKey: caseRow.caseKey,
        jurisdiction: caseRow.jurisdiction,
        sourceType: caseRow.sourceType,
        sourceUrl: caseRow.sourceUrl,
        title: fields ? fields.title : caseRow.title,
        authority: fields ? fields.authority : caseRow.authority,
        regulationNumber: fields
          ? fields.regulationNumber
          : caseRow.regulationNumber,
        category: fields ? fields.category : caseRow.category,
        summary: fields ? fields.summary : caseRow.summary,
        applicability: fields ? fields.applicability : caseRow.applicability,
        seasonalRecurrence: fields
          ? fields.seasonalRecurrence
          : caseRow.seasonalRecurrence,
        interpretationNotes: fields
          ? fields.interpretationNotes
          : caseRow.interpretationNotes,
        effectiveFrom,
        effectiveTo,
        expiresAt,
        sourcePublishedAt: caseRow.publishedAt,
        publishedAt: caseRow.publishedToUsersAt,
        publishedRevisionId: revisionId,
        metadataOnly: caseRow.publishedMetadataOnly,
        inForce: inForceOf(effectiveFrom, effectiveTo, expiresAt),
        geometries: geometriesByRevision.get(revisionId) ?? [],
      };
    });
  }
}

/** Revision `fields` store instants as ISO strings. */
function dateOrNull(iso: string | null | undefined): Date | null {
  return iso ? new Date(iso) : null;
}

/** Same reading of the validity window as the jmelding geo index: no window
 * means in force, `upcoming` is adopted-but-not-yet-open, and either end
 * date passing makes it `expired`. */
function inForceOf(
  effectiveFrom: Date | null,
  effectiveTo: Date | null,
  expiresAt: Date | null,
): "current" | "upcoming" | "expired" {
  const now = Date.now();
  const end = effectiveTo ?? expiresAt;
  if (end && end.getTime() < now) return "expired";
  if (effectiveFrom && effectiveFrom.getTime() > now) return "upcoming";
  return "current";
}
