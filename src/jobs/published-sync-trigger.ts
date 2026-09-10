import type { JobRunner } from "./runner";

/** The one job this trigger exists to run. */
export const PUBLISHED_SYNC_JOB_ID = "regulation-published-sync";

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
 * - **Late-bound runner.** Pathways are constructed before the JobRunner
 *   exists (src/index.ts order), and boot-time replay can schedule before
 *   `attachRunner` — those schedules are held as pending, not lost.
 * - **`schedule()` never throws.** It is called from pathway handlers; a
 *   sync failure (Usable 5xx, unset collection id) must not fail event
 *   projection. Errors are logged and the corpus catches up on the next
 *   trigger or manual run.
 */
export class PublishedSyncTrigger {
  private runner: JobRunner | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending = false;

  constructor(private readonly debounceMs: number = 3000) {}

  attachRunner(runner: JobRunner): void {
    this.runner = runner;
    if (this.pending) this.arm(this.debounceMs);
  }

  schedule(reason: string): void {
    console.log("[PublishedSyncTrigger] scheduled", { reason });
    this.pending = true;
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
    try {
      await this.runner.runJob(PUBLISHED_SYNC_JOB_ID, "event");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already running")) {
        // A manual/cron run holds the lock. The change that scheduled us is
        // not necessarily covered by it (it may have started earlier), so
        // stay pending and retry after the window instead of dropping.
        this.pending = true;
      } else {
        console.error("[PublishedSyncTrigger] sync run failed", { message });
      }
    } finally {
      this.running = false;
      if (this.pending) this.arm(this.debounceMs);
    }
  }
}
