import { type Database, timestampToIso } from "@/db/client";
import { logasavnReview } from "@/db/schema";
import { sql } from "drizzle-orm";
import type { DetectorVerdict } from "./detection";
import type {
  Recurrence,
  ReviewReason,
  ReviewRow,
  ReviewStatus,
} from "./review";
import { IN_FORCE } from "./sweep";

type DbRow = typeof logasavnReview.$inferSelect;

function toReviewRow(row: DbRow): ReviewRow {
  return {
    fragmentId: row.fragmentId,
    contentHash: row.contentHash,
    isCurrent: row.isCurrent,
    title: row.title,
    authority: row.authority,
    validityStatus: row.validityStatus,
    coordinateLike: row.coordinateLike,
    ringCount: row.ringCount,
    vertexCount: row.vertexCount,
    withheldCount: row.withheldCount,
    detectors: Array.isArray(row.detectors)
      ? (row.detectors as DetectorVerdict[])
      : [],
    reviewStatus: row.reviewStatus as ReviewStatus,
    reviewReason: row.reviewReason as ReviewReason,
    recurrence: (row.recurrence as Recurrence | null) ?? null,
    reviewedBy: row.reviewedBy,
    reviewedAt: timestampToIso(row.reviewedAt) ?? null,
    declineReason: row.declineReason,
    firstSeenAt: timestampToIso(row.firstSeenAt),
    lastSeenAt: timestampToIso(row.lastSeenAt),
  };
}

/**
 * Persistence for the Lógasavn review queue.
 *
 * The upsert below is where the safety property is ENFORCED rather than merely
 * intended: `review_status`, `recurrence`, `reviewed_by`, `reviewed_at` and
 * `decline_reason` appear in the INSERT and never in the `DO UPDATE SET`. A
 * sweep can therefore create a row as `pending`, and can refresh everything it
 * measured, but has no statement anywhere that can change a verdict a human
 * gave. That matters because the two writers are genuinely concurrent — the job
 * lock keeps sweeps apart from each other, but nothing stops a reviewer
 * approving a row in the seconds between a sweep's read and its write, and a
 * whole-row write would silently roll that approval back to pending.
 *
 * A moved hash still re-opens review, because that is a different primary key —
 * a fresh `pending` row, not an update. See `mergeReviewRows`.
 */
export class LogasavnReviewRepository {
  constructor(private readonly db: Database) {}

  async loadAll(): Promise<ReviewRow[]> {
    const rows = await this.db.select().from(logasavnReview);
    return rows.map(toReviewRow);
  }

  /**
   * Rows a human still has to answer for.
   *
   * RANKED, not filtered — every pending row is returned. In-force statutes
   * come first because they are the ~47 that decide what the map shows today,
   * then the ones holding withheld geometry, then the fisheries ministry's own.
   * A superseded statute still has to be reachable: they come back, and a queue
   * that cannot show you one cannot tell you it did.
   *
   * `NULLS LAST` on both boolean keys is load-bearing, not decoration. Postgres
   * orders `DESC` as `NULLS FIRST`, and `null = 'Galdandi'` is null rather than
   * false — so a fragment whose `validity_status` or `authority` failed to parse
   * would sort ABOVE the in-force rows this ordering exists to surface. Ranking
   * a statute we could not read the status of as though it were the most urgent
   * thing in the queue is backwards: unknown is not in force.
   */
  async listPending(): Promise<ReviewRow[]> {
    const rows = await this.db
      .select()
      .from(logasavnReview)
      .where(
        sql`${logasavnReview.isCurrent} AND ${logasavnReview.reviewStatus} = 'pending'`,
      )
      .orderBy(
        sql`(${logasavnReview.validityStatus} = ${IN_FORCE}) DESC NULLS LAST,
            ${logasavnReview.withheldCount} DESC,
            (${logasavnReview.authority} = 'uttanrikis-og-fiskimalaradid') DESC NULLS LAST,
            ${logasavnReview.title} ASC`,
      );
    return rows.map(toReviewRow);
  }

  async apply(rows: ReviewRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.db
      .insert(logasavnReview)
      .values(
        rows.map((row) => ({
          fragmentId: row.fragmentId,
          contentHash: row.contentHash,
          isCurrent: row.isCurrent,
          title: row.title,
          authority: row.authority,
          validityStatus: row.validityStatus,
          coordinateLike: row.coordinateLike,
          ringCount: row.ringCount,
          vertexCount: row.vertexCount,
          withheldCount: row.withheldCount,
          detectors: row.detectors,
          reviewStatus: row.reviewStatus,
          reviewReason: row.reviewReason,
          recurrence: row.recurrence,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt == null ? null : new Date(row.reviewedAt),
          declineReason: row.declineReason,
          firstSeenAt: new Date(row.firstSeenAt),
          lastSeenAt: new Date(row.lastSeenAt),
        })),
      )
      .onConflictDoUpdate({
        target: [logasavnReview.fragmentId, logasavnReview.contentHash],
        // Sweep-owned columns only. The verdict columns are deliberately absent
        // — see the class comment.
        set: {
          isCurrent: sql`excluded.is_current`,
          title: sql`excluded.title`,
          authority: sql`excluded.authority`,
          validityStatus: sql`excluded.validity_status`,
          coordinateLike: sql`excluded.coordinate_like`,
          ringCount: sql`excluded.ring_count`,
          vertexCount: sql`excluded.vertex_count`,
          withheldCount: sql`excluded.withheld_count`,
          detectors: sql`excluded.detectors`,
          reviewReason: sql`excluded.review_reason`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
    return rows.length;
  }
}
