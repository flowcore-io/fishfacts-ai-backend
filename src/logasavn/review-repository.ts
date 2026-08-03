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

/** A verdict that a re-decision overwrote, reported so it is not lost silently. */
export type PriorVerdict = {
  status: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  declineReason: string | null;
};

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
    return this.listForReview({ status: "pending" });
  }

  /**
   * The queue, filtered and ranked for a human working through it.
   *
   * Every filter is OPTIONAL and defaults to off, so the unfiltered call
   * returns everything current. That direction matters: a list endpoint whose
   * default hides rows is how a statute stops being looked at without anyone
   * choosing to stop looking at it.
   */
  async listForReview(
    filters: {
      status?: ReviewStatus;
      reason?: ReviewReason;
      /** Only statutes currently in force. */
      inForceOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ReviewRow[]> {
    const conditions = [sql`${logasavnReview.isCurrent}`];
    if (filters.status) {
      conditions.push(sql`${logasavnReview.reviewStatus} = ${filters.status}`);
    }
    if (filters.reason) {
      conditions.push(sql`${logasavnReview.reviewReason} = ${filters.reason}`);
    }
    if (filters.inForceOnly) {
      conditions.push(sql`${logasavnReview.validityStatus} = ${IN_FORCE}`);
    }
    let where = conditions[0] as ReturnType<typeof sql>;
    for (let i = 1; i < conditions.length; i++) {
      where = sql`${where} AND ${conditions[i]}`;
    }
    const rows = await this.db
      .select()
      .from(logasavnReview)
      .where(where)
      .orderBy(
        sql`(${logasavnReview.validityStatus} = ${IN_FORCE}) DESC NULLS LAST,
            ${logasavnReview.withheldCount} DESC,
            (${logasavnReview.authority} = 'uttanrikis-og-fiskimalaradid') DESC NULLS LAST,
            ${logasavnReview.title} ASC`,
      )
      .limit(filters.limit ?? 500)
      .offset(filters.offset ?? 0);
    return rows.map(toReviewRow);
  }

  /**
   * Queue shape at a glance, so a reviewer knows what they are facing.
   *
   * Counted in the database rather than in JS. This runs alongside EVERY list
   * call, and the JS version pulled every current row — `detectors` payload and
   * all — purely to increment three counters. The grouped form returns at most
   * a few dozen rows however large the queue gets.
   */
  async summarise(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
    inForcePending: number;
  }> {
    const groups = await this.db
      .select({
        status: logasavnReview.reviewStatus,
        reason: logasavnReview.reviewReason,
        validity: logasavnReview.validityStatus,
        n: sql<number>`count(*)::int`,
      })
      .from(logasavnReview)
      .where(sql`${logasavnReview.isCurrent}`)
      .groupBy(
        logasavnReview.reviewStatus,
        logasavnReview.reviewReason,
        logasavnReview.validityStatus,
      );

    // `byStatus` and `byReason` are marginals of the same grouping, so folding
    // them here is exact rather than approximate.
    const byStatus: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    let total = 0;
    let inForcePending = 0;
    for (const group of groups) {
      total += group.n;
      byStatus[group.status] = (byStatus[group.status] ?? 0) + group.n;
      byReason[group.reason] = (byReason[group.reason] ?? 0) + group.n;
      if (group.status === "pending" && group.validity === IN_FORCE) {
        inForcePending += group.n;
      }
    }
    return { total, byStatus, byReason, inForcePending };
  }

  /**
   * Record a human's decision about ONE exact statute text.
   *
   * The `content_hash` is part of the target, not a detail: an approval is an
   * approval OF SPECIFIC TEXT, so the caller has to say which text they read.
   * If the sweep re-scraped the statute between the reviewer loading the row
   * and deciding on it, the hash they hold is no longer current and the write
   * is REFUSED rather than applied to text they never saw. That is the same
   * pin `mergeReviewRows` enforces, surfacing at the API as ordinary optimistic
   * concurrency.
   *
   * **Re-deciding the CURRENT text is allowed on purpose.** A reviewer who
   * approves a treaty boundary by mistake has to be able to take it back, and
   * making them wait for the source to change before they can is absurd. The
   * hash pin guards against deciding text nobody read; it was never meant to
   * make a decision permanent.
   *
   * But the table holds ONE verdict per text by design, so re-deciding
   * overwrites the previous `reviewed_by`/`reviewed_at`. That overwrite is
   * therefore reported back rather than done silently — the caller is told what
   * it replaced, and the route logs it. A durable decision history would need
   * its own table; recorded as a follow-up rather than smuggled in here.
   *
   * Runs in a transaction with `FOR UPDATE` because it reads to classify and
   * then writes: without the lock, two reviewers deciding the same row at once
   * could each read `pending` and the second would silently overwrite the first
   * with no `replaced` reported at all — the exact thing this returns.
   *
   * Returns a discriminated result rather than throwing, because "your view is
   * stale" is a normal thing for a reviewer to hit and the route needs to tell
   * them the new hash so they can re-read and decide again.
   */
  async recordVerdict(input: {
    fragmentId: string;
    contentHash: string;
    status: Exclude<ReviewStatus, "pending">;
    declineReason?: string | null;
    recurrence?: Recurrence | null;
    reviewedBy: string;
  }): Promise<
    | { outcome: "recorded"; row: ReviewRow; replaced: PriorVerdict | null }
    | { outcome: "stale"; currentHash: string }
    | { outcome: "not_found" }
  > {
    return this.db.transaction(async (tx) => {
      const held = await tx
        .select()
        .from(logasavnReview)
        .where(
          sql`${logasavnReview.fragmentId} = ${input.fragmentId} AND ${logasavnReview.isCurrent}`,
        )
        .limit(1)
        .for("update");
      const current = held[0];
      if (!current) return { outcome: "not_found" as const };
      if (current.contentHash !== input.contentHash) {
        return { outcome: "stale" as const, currentHash: current.contentHash };
      }

      const replaced: PriorVerdict | null =
        current.reviewStatus === "pending"
          ? null
          : {
              status: current.reviewStatus as ReviewStatus,
              reviewedBy: current.reviewedBy,
              reviewedAt: timestampToIso(current.reviewedAt) ?? null,
              declineReason: current.declineReason,
            };

      const updated = await tx
        .update(logasavnReview)
        .set({
          reviewStatus: input.status,
          declineReason: input.declineReason ?? null,
          recurrence: input.recurrence ?? null,
          reviewedBy: input.reviewedBy,
          reviewedAt: new Date(),
        })
        .where(
          sql`${logasavnReview.fragmentId} = ${input.fragmentId}
              AND ${logasavnReview.contentHash} = ${input.contentHash}`,
        )
        .returning();
      return {
        outcome: "recorded" as const,
        row: toReviewRow(updated[0] as DbRow),
        replaced,
      };
    });
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
