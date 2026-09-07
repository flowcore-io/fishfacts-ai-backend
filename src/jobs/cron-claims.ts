import type { Database } from "@/db/client";
import { jobCronClaims } from "@/db/schema";
import { lt } from "drizzle-orm";

/**
 * How long a claim row is kept. Only needs to outlive the minute it guards;
 * the margin is for clock skew between replicas.
 */
const CLAIM_RETENTION_MS = 60 * 60 * 1000;

/** How often a claim also kicks off a (non-blocking) prune of expired rows. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Cross-replica guard for scheduled runs.
 *
 * The scheduler runs in-process in every pod and tracks "already fired this
 * minute" in a Map, which is per-process — so at `replicas: 2` every cron job
 * fired twice, a few seconds apart, against every upstream we scrape. Claiming
 * the (job, minute) pair in Postgres first makes exactly one replica win.
 */
export class JobCronClaims {
  private lastPrunedMs = 0;

  constructor(private readonly db: Database) {}

  /**
   * Returns true if this replica may run `jobId` for `bucket`, false if another
   * replica already claimed it.
   */
  async claim(jobId: string, bucket: string): Promise<boolean> {
    const claimed = await this.db
      .insert(jobCronClaims)
      .values({ jobId, bucket })
      .onConflictDoNothing()
      .returning({ jobId: jobCronClaims.jobId });
    void this.pruneIfDue();
    return claimed.length > 0;
  }

  private pruneIfDue() {
    const now = Date.now();
    if (now - this.lastPrunedMs < PRUNE_INTERVAL_MS) return Promise.resolve();
    this.lastPrunedMs = now;
    return this.db
      .delete(jobCronClaims)
      .where(lt(jobCronClaims.claimedAt, new Date(now - CLAIM_RETENTION_MS)))
      .then(
        () => undefined,
        (error: unknown) => {
          // Pruning is housekeeping — a failure must not stop jobs firing.
          console.error("[Jobs] Cron claim prune failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
  }
}
