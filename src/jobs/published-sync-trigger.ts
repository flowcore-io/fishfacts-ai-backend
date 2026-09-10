import { JobAlreadyRunningError, type JobRunner } from "./runner";

/** The one job this trigger exists to run. */
export const PUBLISHED_SYNC_JOB_ID = "regulation-published-sync";

/**
 * Retries after a generic sync failure (Usable 5xx, network). Five attempts
 * at a growing interval spans several minutes of outage; past that the
 * outage is not transient and a human signal (the error log) beats more
 * silent traffic. A NEW schedule() restores the full budget — new change,
 * new attempt at delivering it.
 */
const GENERIC_RETRY_BUDGET = 5;

/**
 * Fires `regulation-published-sync` whenever the published set changes —
 * an applied approval publishes, a decline un-publishes — so the Usable
 * corpus follows admin actions without anyone remembering to run the job.
 * The manual run stays for backfills; this only adds the event-driven path.
 *
 * Shape constraints, each load-bearing:
 *
 * - **Debounced, not per-event.** A full pathway replay re-lands every
 *   approval ever recorded; one sync per event would queue hundreds of
 *   identical full-corpus runs. Every `schedule()` inside the window
 *   collapses into one run.
 * - **Serialized with re-run.** The runner throws on a concurrent start of
 *   the same job, and a `schedule()` arriving MID-run may describe a change
 *   the running pass has already read past — so it must trigger another
 *   pass, never be dropped.
 * - **Failures retry, bounded.** With the cron slot impossible, this trigger
 *   is the only automatic path — a dropped decline sync leaves a rejected
 *   regulation retrievable in chat. Transient failures retry on a backoff
 *   ({@link GENERIC_RETRY_BUDGET}); a lock collision with a manual run
 *   retries without spending that budget (the manual run is not a failure).
 * - **Late-bound runner.** Pathways are constructed before the JobRunner
 *   exists (src/index.ts order), and boot-time replay can schedule before
 *   `attachRunner` — those schedules are held as pending, not lost.
 * - **`schedule()` never throws.** It is called from pathway handlers; a
 *   sync failure must not fail event projection.
 */
export class PublishedSyncTrigger {
  private runner: JobRunner | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending = false;
  private retriesLeft = GENERIC_RETRY_BUDGET;

  constructor(
    private readonly debounceMs: number = 3000,
    /** Base of the failure backoff: attempt n waits n × this. */
    private readonly retryBaseMs: number = 30_000,
  ) {}

  attachRunner(runner: JobRunner): void {
    this.runner = runner;
    if (this.pending) this.arm(this.debounceMs);
  }

  schedule(reason: string): void {
    console.log("[PublishedSyncTrigger] scheduled", { reason });
    this.pending = true;
    this.retriesLeft = GENERIC_RETRY_BUDGET;
    this.arm(this.debounceMs);
  }

  private arm(delayMs: number): void {
    if (!this.runner || this.timer !== null || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (!this.runner || this.running) return;
    this.running = true;
    this.pending = false;
    let nextDelayMs = this.debounceMs;
    try {
      await this.runner.runJob(PUBLISHED_SYNC_JOB_ID, "event");
      this.retriesLeft = GENERIC_RETRY_BUDGET;
    } catch (error) {
      if (error instanceof JobAlreadyRunningError) {
        // A manual/cron run holds the lock. The change that scheduled us is
        // not necessarily covered by it (it may have started earlier), so
        // stay pending and retry after the window instead of dropping.
        this.pending = true;
      } else if (this.retriesLeft > 0) {
        const attempt = GENERIC_RETRY_BUDGET - this.retriesLeft + 1;
        this.retriesLeft -= 1;
        this.pending = true;
        nextDelayMs = attempt * this.retryBaseMs;
        console.warn("[PublishedSyncTrigger] sync failed — will retry", {
          attempt,
          nextDelayMs,
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        console.error(
          "[PublishedSyncTrigger] sync failed with retries exhausted — " +
            "corpus catches up on the next event or a manual run",
          {
            message: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } finally {
      this.running = false;
      if (this.pending) this.arm(nextDelayMs);
    }
  }
}
