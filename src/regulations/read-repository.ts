import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

/**
 * Read side of the regulations approval queue (stage ② B1) — what the admin
 * Regulations Inbox lists and opens. Strictly read-only: every write to these
 * tables is an event with a projector, never a route handler.
 */

export type QueueListFilters = {
  adminStatus?: string[];
  jurisdiction?: string[];
  urgency?: string[];
  assignee?: string;
  /** true → unread only; false → read only; undefined → both. */
  unread?: boolean;
  /** Snoozed cases are hidden from the inbox until `snooze_until` passes;
   * true shows them anyway. */
  includeSnoozed?: boolean;
  limit: number;
  offset: number;
};

/**
 * Urgency outranks recency: §12 wants urgent cases visually prominent even
 * after they are read, and an inbox that lets a fresh routine case bury an
 * urgent one fails that. The vocabulary is written by stage ② B2; unknown or
 * unset urgency sorts last rather than erroring, so the ordering never
 * depends on the write side having caught up.
 */
const urgencyRank = sql`CASE ${schema.regulationCases.urgency}
  WHEN 'critical' THEN 0
  WHEN 'high' THEN 1
  WHEN 'medium' THEN 2
  WHEN 'low' THEN 3
  ELSE 4 END`;

const notSnoozed = or(
  isNull(schema.regulationCases.snoozeUntil),
  lte(schema.regulationCases.snoozeUntil, sql`now()`),
);

function queueConditions(filters: QueueListFilters) {
  const conditions = [];
  if (filters.adminStatus && filters.adminStatus.length > 0) {
    conditions.push(
      inArray(schema.regulationCases.adminStatus, filters.adminStatus),
    );
  }
  if (filters.jurisdiction && filters.jurisdiction.length > 0) {
    conditions.push(
      inArray(schema.regulationCases.jurisdiction, filters.jurisdiction),
    );
  }
  if (filters.urgency && filters.urgency.length > 0) {
    conditions.push(inArray(schema.regulationCases.urgency, filters.urgency));
  }
  if (filters.assignee !== undefined) {
    conditions.push(eq(schema.regulationCases.assignee, filters.assignee));
  }
  if (filters.unread !== undefined) {
    conditions.push(eq(schema.regulationCases.isRead, !filters.unread));
  }
  if (!filters.includeSnoozed) {
    conditions.push(notSnoozed);
  }
  return conditions;
}

/** The §12 queue-list columns; the full record stays on the detail read. */
const queueListColumns = {
  id: schema.regulationCases.id,
  caseKey: schema.regulationCases.caseKey,
  title: schema.regulationCases.title,
  authority: schema.regulationCases.authority,
  regulationNumber: schema.regulationCases.regulationNumber,
  jurisdiction: schema.regulationCases.jurisdiction,
  sourceType: schema.regulationCases.sourceType,
  sourceUrl: schema.regulationCases.sourceUrl,
  category: schema.regulationCases.category,
  summary: schema.regulationCases.summary,
  changeType: schema.regulationCases.changeType,
  caseType: schema.regulationCases.caseType,
  adminStatus: schema.regulationCases.adminStatus,
  regulationStatus: schema.regulationCases.regulationStatus,
  sourceComparison: schema.regulationCases.sourceComparison,
  verdictStatus: schema.regulationCases.verdictStatus,
  regulatoryValidated: schema.regulationCases.regulatoryValidated,
  geometryValidated: schema.regulationCases.geometryValidated,
  urgency: schema.regulationCases.urgency,
  assignee: schema.regulationCases.assignee,
  isRead: schema.regulationCases.isRead,
  snoozeUntil: schema.regulationCases.snoozeUntil,
  effectiveFrom: schema.regulationCases.effectiveFrom,
  effectiveTo: schema.regulationCases.effectiveTo,
  expiresAt: schema.regulationCases.expiresAt,
  firstSeenAt: schema.regulationCases.firstSeenAt,
  updatedAt: schema.regulationCases.updatedAt,
  currentRevisionId: schema.regulationCases.currentRevisionId,
};

export type QueueListCase = Pick<
  typeof schema.regulationCases.$inferSelect,
  keyof typeof queueListColumns
>;

export type QueueCounts = {
  unread: number;
  snoozed: number;
  byAdminStatus: Record<string, number>;
};

export class RegulationQueueReadRepository {
  constructor(private readonly db: Database) {}

  async listQueue(
    filters: QueueListFilters,
  ): Promise<{ cases: QueueListCase[]; total: number }> {
    const conditions = queueConditions(filters);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const cases = await this.db
      .select(queueListColumns)
      .from(schema.regulationCases)
      .where(where)
      .orderBy(
        asc(urgencyRank),
        // Newest queued first within an urgency band — the inbox convention,
        // and the opposite of the verdict job (which drains oldest-first).
        sql`${schema.regulationCases.firstSeenAt} DESC`,
      )
      .limit(filters.limit)
      .offset(filters.offset);
    const [totals] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.regulationCases)
      .where(where);
    return { cases, total: totals?.total ?? 0 };
  }

  /** Badge numbers for the inbox entry point ("7 unread"). Snoozed cases are
   * excluded from `unread` — hidden means not nagging — and surfaced as their
   * own count instead. */
  async counts(): Promise<QueueCounts> {
    const [unreadRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.regulationCases)
      .where(and(eq(schema.regulationCases.isRead, false), notSnoozed));
    const [snoozedRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.regulationCases)
      .where(sql`${schema.regulationCases.snoozeUntil} > now()`);
    const statusRows = await this.db
      .select({
        adminStatus: schema.regulationCases.adminStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.regulationCases)
      .groupBy(schema.regulationCases.adminStatus);
    return {
      unread: unreadRow?.count ?? 0,
      snoozed: snoozedRow?.count ?? 0,
      byAdminStatus: Object.fromEntries(
        statusRows.map((row) => [row.adminStatus, row.count]),
      ),
    };
  }

  /**
   * Everything the case-detail screen shows: the case, its revision history
   * (each revision with its own geometries — validation is per-area, so the
   * areas stay addressable), attached sources and replacement links. The
   * revision list IS the B1 audit trail; the action events land in B2/B3.
   */
  async getCaseDetail(caseId: string) {
    const [caseRow] = await this.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, caseId))
      .limit(1);
    if (!caseRow) return null;
    const [revisions, geometries, sources, links] = await Promise.all([
      this.db
        .select()
        .from(schema.regulationCaseRevisions)
        .where(eq(schema.regulationCaseRevisions.caseId, caseId))
        .orderBy(asc(schema.regulationCaseRevisions.position)),
      this.db
        .select({
          id: schema.regulationCaseGeometries.id,
          revisionId: schema.regulationCaseGeometries.revisionId,
          position: schema.regulationCaseGeometries.position,
          name: schema.regulationCaseGeometries.name,
          section: schema.regulationCaseGeometries.section,
          kind: schema.regulationCaseGeometries.kind,
          season: schema.regulationCaseGeometries.season,
          verticesQuoted: schema.regulationCaseGeometries.verticesQuoted,
          points: schema.regulationCaseGeometries.points,
          geometrySource: schema.regulationCaseGeometries.geometrySource,
          coordinateSystem: schema.regulationCaseGeometries.coordinateSystem,
          precision: schema.regulationCaseGeometries.precision,
          geometryValidated: schema.regulationCaseGeometries.geometryValidated,
        })
        .from(schema.regulationCaseGeometries)
        .where(eq(schema.regulationCaseGeometries.caseId, caseId))
        .orderBy(asc(schema.regulationCaseGeometries.position)),
      this.db
        .select()
        .from(schema.regulationCaseSources)
        .where(eq(schema.regulationCaseSources.caseId, caseId)),
      this.db
        .select()
        .from(schema.regulationCaseLinks)
        .where(eq(schema.regulationCaseLinks.caseId, caseId)),
    ]);
    const geometriesByRevision = new Map<string, typeof geometries>();
    for (const geometry of geometries) {
      const list = geometriesByRevision.get(geometry.revisionId) ?? [];
      list.push(geometry);
      geometriesByRevision.set(geometry.revisionId, list);
    }
    return {
      case: caseRow,
      revisions: revisions.map((revision) => ({
        ...revision,
        isCurrent: revision.id === caseRow.currentRevisionId,
        geometries: geometriesByRevision.get(revision.id) ?? [],
      })),
      sources,
      links,
    };
  }
}
