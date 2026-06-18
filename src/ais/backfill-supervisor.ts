import type { Env } from "@/env";
import type { JobRunner } from "@/jobs/runner";
import type { Sql } from "postgres";
import type { AisIngestStateRepository } from "./ingest-state-repository";

const BACKFILL_JOB_ID = "ais-position-backfill";
const CH_REFILL_JOB_ID = "ais-position-ch-refill";
// Fixed pg advisory-lock key: only ONE pod across the cluster holds it and runs
// the supervised AIS jobs. Without this, every replica's supervisor started its
// own emit + refill runs → concurrent runs clobbering the shared job-state
// fragment and multiplying the Usable write load.
const SUPERVISOR_LOCK_KEY = 414400823;

/**
 * Auto-restart/resume supervisor for the historical pipeline. Neither job is
 * scheduled (manual-only), and a run dies with its pod on crash/deploy — so on
 * its own nothing resumes them. This interval, on every tick (while the durable
 * `backfill_enabled` switch is on):
 *   1. (re)starts the EMIT job (MySQL → Flowcore) over [backfillStartAt, T0) desc
 *      if it isn't already running;
 *   2. (re)starts the CH-REFILL job (Flowcore → ClickHouse) if it isn't running
 *      and there are emitted-but-not-projected buckets.
 * The two are decoupled: the refill consumes whatever the emit has produced.
 * Resume + idempotency come from `ais_backfill_buckets` (Postgres) + SKIP LOCKED,
 * so re-runs after a failure are cheap and safe. Under replicas>1 only ONE pod
 * runs the supervised jobs — elected via a Postgres advisory lock (`isLeader`) —
 * so we don't spawn concurrent emit/refill runs that clobber the shared
 * job-state fragment and multiply Usable writes. (Bucket workers within that one
 * run still parallelize via SKIP LOCKED.)
 */
export class AisBackfillSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Reserved (pinned) connection that holds the advisory lock while this pod is
  // the elected supervisor. Held for the supervisor's lifetime; on pod death the
  // connection drops and Postgres auto-releases the lock so another pod takes over.
  private leaderConn: Awaited<ReturnType<Sql["reserve"]>> | null = null;

  constructor(
    private readonly env: Env,
    private readonly jobRunner: JobRunner,
    private readonly state: AisIngestStateRepository,
    private readonly sql: Sql,
    private readonly intervalMs = 60_000,
  ) {}

  /** True only on the single pod holding the advisory lock. */
  private async isLeader(): Promise<boolean> {
    if (this.leaderConn) {
      try {
        await this.leaderConn`select 1`;
        return true; // still hold a live locked connection
      } catch {
        try {
          await this.leaderConn.release();
        } catch {}
        this.leaderConn = null; // connection died → lock released; re-acquire below
      }
    }
    try {
      const conn = await this.sql.reserve();
      const rows =
        await conn`select pg_try_advisory_lock(${SUPERVISOR_LOCK_KEY}) as locked`;
      if (rows[0]?.locked) {
        this.leaderConn = conn;
        return true;
      }
      await conn.release();
      return false;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error("[AIS] backfill supervisor tick failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.leaderConn) {
      const conn = this.leaderConn;
      this.leaderConn = null;
      void conn.release(); // drops the reserved connection → releases the lock
    }
  }

  private async tick(): Promise<void> {
    if (!(await this.isLeader())) return; // another pod owns the supervisor
    const control = await this.state.getControl();
    if (!control.backfillEnabled) return; // durable pause
    if (!control.backfillStartAt || !control.startAt) {
      console.error(
        "[AIS] backfill enabled but startAt/backfillStartAt unset — call POST /api/ais/enable first",
      );
      return;
    }

    const running = this.jobRunner.getRunningJobIds();

    // 1. EMIT (MySQL → Flowcore). Resumes from Postgres bucket state; range
    // [oldest, T0) newest-first so recent history lands first.
    if (!running.includes(BACKFILL_JOB_ID)) {
      this.startFireAndForget(BACKFILL_JOB_ID, {
        order: "desc",
        startAt: control.backfillStartAt,
        endAt: control.startAt,
        bucketConcurrency: this.env.AIS_BACKFILL_BUCKET_CONCURRENCY,
      });
    }

    // 2. CH-REFILL (Flowcore → ClickHouse) — only if there's a projection backlog.
    if (!running.includes(CH_REFILL_JOB_ID)) {
      const backlog = await this.state.pendingProjectionCount();
      if (backlog > 0) {
        this.startFireAndForget(CH_REFILL_JOB_ID, {
          order: "desc",
          concurrency: this.env.AIS_CH_REFILL_CONCURRENCY,
        });
      }
    }
  }

  private startFireAndForget(
    jobId: string,
    args: Record<string, unknown>,
  ): void {
    // A concurrent start (race with the running-check) just throws "already
    // running" — benign.
    this.jobRunner
      .startJob(jobId, "cron", args)
      .then((started) =>
        started.promise.catch((error: unknown) => {
          console.error(`[AIS] supervised ${jobId} run failed (will retry)`, {
            message: error instanceof Error ? error.message : String(error),
          });
        }),
      )
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("already running")) {
          console.error(`[AIS] failed to start ${jobId}`, { message: msg });
        }
      });
  }
}
