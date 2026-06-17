import type { Env } from "@/env";
import type { JobRunner } from "@/jobs/runner";
import type { AisIngestStateRepository } from "./ingest-state-repository";

const BACKFILL_JOB_ID = "ais-position-backfill";

/**
 * Auto-restart/resume supervisor for the historical backfill. The backfill cron
 * never fires (manual-only), and a job run dies with its pod on crash/deploy —
 * so on its own nothing resumes it. This interval, on every tick:
 *   1. honors the durable `backfill_enabled` switch (pause/resume),
 *   2. skips if the backfill is already running on this pod,
 *   3. otherwise (re)starts it over [backfillStartAt, T0) order=desc.
 * Resume + idempotency come from `ais_backfill_buckets` (Postgres) + the
 * additive skip-check, so re-runs after a failure are cheap and safe. Under
 * replicas>1, each pod's supervisor starts a run; `claimNextBucket`'s
 * FOR UPDATE SKIP LOCKED hands distinct buckets to each (safe, parallel).
 */
export class AisBackfillSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly env: Env,
    private readonly jobRunner: JobRunner,
    private readonly state: AisIngestStateRepository,
    private readonly intervalMs = 60_000,
  ) {}

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
  }

  private async tick(): Promise<void> {
    const control = await this.state.getControl();
    if (!control.backfillEnabled) return; // durable pause
    if (!control.backfillStartAt || !control.startAt) {
      console.error(
        "[AIS] backfill enabled but startAt/backfillStartAt unset — call POST /api/ais/enable first",
      );
      return;
    }
    if (this.jobRunner.getRunningJobIds().includes(BACKFILL_JOB_ID)) return;

    // Fire-and-forget; resumes from Postgres bucket state. Range [oldest, T0)
    // newest-first so recent history lands first. A concurrent start (race with
    // the running-check) just throws "already running" — benign.
    try {
      const started = await this.jobRunner.startJob(BACKFILL_JOB_ID, "cron", {
        order: "desc",
        startAt: control.backfillStartAt,
        endAt: control.startAt,
        bucketConcurrency: this.env.AIS_BACKFILL_BUCKET_CONCURRENCY,
      });
      started.promise.catch((error: unknown) => {
        console.error("[AIS] supervised backfill run failed (will retry)", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("already running")) throw error;
    }
  }
}
