import type { Env } from "@/env";
import { type JobStateStore, createRunId } from "./state-store";
import type { JobDefinition, PersistedJobState } from "./types";

type RunningJobHandle = {
  abortController: AbortController;
  stopRequested: boolean;
};

function describeError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") return base;
  const parts: string[] = [base];
  const response = (error as { response?: unknown }).response;
  if (response !== undefined) {
    try {
      parts.push(`response=${JSON.stringify(response)}`);
    } catch {
      parts.push(`response=${String(response)}`);
    }
  }
  const exception = (error as { exception?: unknown }).exception;
  if (exception !== undefined && exception !== error) {
    parts.push(
      `cause=${exception instanceof Error ? exception.message : String(exception)}`,
    );
  }
  return parts.join(" | ");
}

function normalizeProgress<
  T extends NonNullable<PersistedJobState["job"]["progress"]>,
>(progress: T): T {
  const detailPercent =
    typeof progress.detailsProcessed === "number" &&
    typeof progress.detailsTotal === "number" &&
    progress.detailsTotal > 0
      ? Math.max(
          1,
          Math.round((progress.detailsProcessed / progress.detailsTotal) * 100),
        )
      : undefined;
  const pagePercent =
    typeof progress.pagesProcessed === "number" &&
    typeof progress.pagesTotal === "number" &&
    progress.pagesTotal > 0
      ? Math.max(
          1,
          Math.round((progress.pagesProcessed / progress.pagesTotal) * 30),
        )
      : undefined;
  const percent = Math.max(
    0,
    Math.min(100, progress.percent ?? detailPercent ?? pagePercent ?? 0),
  );
  return { ...progress, percent };
}

export class JobRunner {
  private readonly runningJobs = new Map<string, RunningJobHandle>();

  constructor(
    private readonly jobs: JobDefinition[],
    private readonly stateStore: JobStateStore,
    private readonly env: Env,
  ) {}

  definitions() {
    return this.jobs;
  }

  getRunningJobIds() {
    return Array.from(this.runningJobs.keys());
  }

  private getDefinition(jobId: string) {
    const definition = this.jobs.find((job) => job.id === jobId);
    if (!definition) throw new Error(`Unknown job: ${jobId}`);
    return definition;
  }

  async runJob(jobId: string, trigger: "manual" | "cron", rawArgs?: unknown) {
    const started = await this.startJob(jobId, trigger, rawArgs);
    await started.promise;
    return started.result();
  }

  async startJob(jobId: string, trigger: "manual" | "cron", rawArgs?: unknown) {
    const definition = this.getDefinition(jobId);
    const args = definition.inputSchema.parse(rawArgs ?? {});
    if (this.runningJobs.has(jobId)) {
      throw new Error(`Job ${jobId} is already running`);
    }
    const abortController = new AbortController();
    this.runningJobs.set(jobId, { abortController, stopRequested: false });
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const runId = createRunId();
    // Release the in-memory lock if any pre-IIFE step throws — otherwise a
    // transient failure here (e.g. Usable HTTP 5xx on the initial save) would
    // leak the runningJobs entry forever, because the IIFE's finally never
    // runs and every subsequent cron tick would fail with "already running".
    let persisted: Awaited<ReturnType<JobStateStore["save"]>>;
    let previousJobState: PersistedJobState["job"];
    try {
      const loaded = await this.stateStore.load(jobId);
      const state = loaded.state;
      previousJobState = structuredClone(state.job);
      state.job.lastRunStatus = "running";
      state.job.lastRunAt = startedAt;
      state.job.lastError = undefined;
      state.job.metrics.runs += 1;
      state.job.progress = {
        phase: "starting",
        message: "Starting run",
        percent: 0,
        updatedAt: startedAt,
      };
      state.runs = [
        {
          runId,
          jobId,
          startedAt,
          status: "running",
          trigger,
          args: args as Record<string, unknown>,
        },
        ...state.runs,
      ];
      persisted = await this.stateStore.save({
        jobId,
        fragmentId: loaded.fragmentId,
        state,
      });
    } catch (preIifeError) {
      this.runningJobs.delete(jobId);
      throw preIifeError;
    }
    let completed:
      | {
          fragmentId: string | null;
          state: PersistedJobState;
          result: Awaited<ReturnType<JobDefinition["execute"]>>;
        }
      | undefined;
    let progressSaveChain = Promise.resolve();
    // Throttle in-run PROGRESS saves: reportProgress() can fire many times/second
    // (the AIS backfill emits thousands of rows/s), and each save is a Usable
    // fragment PATCH. Coalesce them to ≤1 write per JOB_PROGRESS_SAVE_MIN_INTERVAL_MS.
    // The latest progress is already mutated into persisted.state, so a single
    // trailing save captures it. Start/terminal/checkpoint saves bypass this.
    const progressMinIntervalMs = this.env.JOB_PROGRESS_SAVE_MIN_INTERVAL_MS;
    let lastProgressSaveMs = 0;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingProgress = () => {
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
    };
    const flushProgressSave = () => {
      lastProgressSaveMs = Date.now();
      progressSaveChain = progressSaveChain
        .catch(() => undefined)
        .then(async () => {
          persisted.state.updatedAt = new Date().toISOString();
          persisted = await this.stateStore.save({
            jobId,
            fragmentId: persisted.fragmentId,
            state: persisted.state,
          });
        });
      void progressSaveChain.catch((error) => {
        console.error("[Jobs] Progress save failed", {
          jobId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };
    const persistProgress = () => {
      if (progressTimer) return; // a trailing save is already scheduled
      const sinceLast = Date.now() - lastProgressSaveMs;
      if (sinceLast >= progressMinIntervalMs) {
        flushProgressSave();
      } else {
        progressTimer = setTimeout(() => {
          progressTimer = null;
          flushProgressSave();
        }, progressMinIntervalMs - sinceLast);
        progressTimer.unref?.();
      }
    };
    console.log(
      `[JobRunner] starting job ${jobId} (runId=${runId}, trigger=${trigger}, args=${JSON.stringify(args)})`,
    );
    const promise = (async () => {
      try {
        const executeStart = Date.now();
        console.log(`[JobRunner] ${jobId} execute() awaiting (runId=${runId})`);
        const result = await definition.execute(previousJobState, args, {
          signal: abortController.signal,
          isStopRequested: () =>
            this.runningJobs.get(jobId)?.stopRequested === true,
          reportProgress: (progress) => {
            const nextProgress = normalizeProgress({
              ...(persisted.state.job.progress ?? {
                phase: "running",
                updatedAt: startedAt,
              }),
              ...progress,
              updatedAt: new Date().toISOString(),
            });
            persisted.state.job.progress = {
              ...nextProgress,
            };
            persistProgress();
          },
          checkpoint: async (update) => {
            cancelPendingProgress();
            await progressSaveChain.catch(() => undefined);
            update(persisted.state);
            if (persisted.state.job.progress) {
              persisted.state.job.progress = normalizeProgress(
                persisted.state.job.progress,
              );
            }
            persisted.state.updatedAt = new Date().toISOString();
            persisted = await this.stateStore.save({
              jobId,
              fragmentId: persisted.fragmentId,
              state: persisted.state,
            });
          },
        });
        console.log(
          `[JobRunner] ${jobId} execute() returned after ${Date.now() - executeStart}ms (runId=${runId}, changed=${result.changed})`,
        );
        const finishedAt = new Date().toISOString();
        cancelPendingProgress();
        await progressSaveChain.catch((drainError) => {
          console.error(
            "[Jobs] Progress save chain drained with error before terminal save",
            {
              jobId,
              runId,
              message:
                drainError instanceof Error
                  ? drainError.message
                  : String(drainError),
            },
          );
        });
        const nextState = persisted.state;
        nextState.updatedAt = finishedAt;
        nextState.job.lastRunStatus = "success";
        nextState.job.lastSuccessAt = finishedAt;
        nextState.job.lastCheckedAt = result.checkedAt;
        nextState.job.lastDurationMs = Date.now() - startedMs;
        nextState.job.latestItems = result.latestItems;
        nextState.job.metrics.successes += 1;
        if (result.changed) nextState.job.metrics.newDataEvents += 1;
        nextState.job.progress = {
          ...(nextState.job.progress ?? {
            phase: "completed",
            updatedAt: finishedAt,
          }),
          phase: "completed",
          message: result.message,
          percent: 100,
          updatedAt: finishedAt,
        };
        this.finishRun(
          nextState,
          runId,
          "success",
          finishedAt,
          Date.now() - startedMs,
          result.changed,
        );
        try {
          persisted = await this.stateStore.save({
            jobId,
            fragmentId: persisted.fragmentId,
            state: nextState,
          });
        } catch (saveError) {
          console.error(
            "[Jobs] CRITICAL: failed to persist success terminal status",
            {
              jobId,
              runId,
              message:
                saveError instanceof Error
                  ? saveError.message
                  : String(saveError),
              stack: saveError instanceof Error ? saveError.stack : undefined,
            },
          );
          throw saveError;
        }
        completed = {
          fragmentId: persisted.fragmentId,
          state: persisted.state,
          result,
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const message = describeError(error);
        console.error("[Jobs] run failed", {
          jobId,
          runId,
          message,
          name: error instanceof Error ? error.name : undefined,
          response: (error as { response?: unknown })?.response,
          stack: error instanceof Error ? error.stack : undefined,
        });
        cancelPendingProgress();
        await progressSaveChain.catch((drainError) => {
          console.error(
            "[Jobs] Progress save chain drained with error after run failure",
            {
              jobId,
              runId,
              message:
                drainError instanceof Error
                  ? drainError.message
                  : String(drainError),
            },
          );
        });
        const nextState = persisted.state;
        nextState.updatedAt = finishedAt;
        nextState.job.lastRunStatus = abortController.signal.aborted
          ? "cancelled"
          : "error";
        nextState.job.lastError = abortController.signal.aborted
          ? undefined
          : message;
        nextState.job.lastErrorAt = abortController.signal.aborted
          ? undefined
          : finishedAt;
        nextState.job.lastDurationMs = Date.now() - startedMs;
        if (!abortController.signal.aborted)
          nextState.job.metrics.failures += 1;
        nextState.job.progress = {
          ...(nextState.job.progress ?? {
            phase: "error",
            updatedAt: finishedAt,
          }),
          phase: abortController.signal.aborted ? "cancelled" : "error",
          message: abortController.signal.aborted
            ? "Stopped by request"
            : message,
          percent: nextState.job.progress?.percent,
          updatedAt: finishedAt,
        };
        this.finishRun(
          nextState,
          runId,
          abortController.signal.aborted ? "cancelled" : "error",
          finishedAt,
          Date.now() - startedMs,
          undefined,
          message,
        );
        try {
          await this.stateStore.save({
            jobId,
            fragmentId: persisted.fragmentId,
            state: nextState,
          });
        } catch (saveError) {
          console.error(
            "[Jobs] CRITICAL: failed to persist error terminal status",
            {
              jobId,
              runId,
              message:
                saveError instanceof Error
                  ? saveError.message
                  : String(saveError),
              stack: saveError instanceof Error ? saveError.stack : undefined,
            },
          );
        }
        throw new Error(message);
      } finally {
        this.runningJobs.delete(jobId);
        cancelPendingProgress();
        // Safety net: if neither the success nor error save path managed to
        // persist a terminal status (silent save failure, swallowed rejection,
        // etc.), force-write a fallback so the runner state cannot stay stuck
        // at "running" — that confuses the next manual /api/jobs/run with a
        // false "already running" error and hides the bug from anyone reading
        // /api/jobs/state.
        if (persisted.state.job.lastRunStatus === "running") {
          const finishedAt = new Date().toISOString();
          const fallbackStatus = abortController.signal.aborted
            ? "cancelled"
            : "error";
          persisted.state.updatedAt = finishedAt;
          persisted.state.job.lastRunStatus = fallbackStatus;
          persisted.state.job.lastDurationMs = Date.now() - startedMs;
          if (fallbackStatus === "error") {
            persisted.state.job.lastError =
              "Run ended without persisting terminal status (runner bug — check earlier CRITICAL logs)";
            persisted.state.job.lastErrorAt = finishedAt;
          }
          try {
            await this.stateStore.save({
              jobId,
              fragmentId: persisted.fragmentId,
              state: persisted.state,
            });
            console.error(
              "[Jobs] CRITICAL: terminal status was missing in finally; wrote fallback",
              { jobId, runId, fallbackStatus },
            );
          } catch (fallbackError) {
            console.error(
              "[Jobs] CRITICAL: fallback terminal status save also failed",
              {
                jobId,
                runId,
                message:
                  fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError),
              },
            );
          }
        }
      }
    })();
    return {
      jobId,
      runId,
      fragmentId: persisted.fragmentId,
      state: persisted.state,
      promise,
      result: () => {
        if (!completed) throw new Error(`Job ${jobId} has not completed`);
        return completed;
      },
    };
  }

  async runAll(trigger: "manual" | "cron") {
    const results: Array<{
      jobId: string;
      status: "success" | "error";
      error?: string;
    }> = [];
    for (const job of this.jobs) {
      try {
        const started = await this.startJob(
          job.id,
          trigger,
          job.inputSchema.parse({}),
        );
        void started.promise.catch((error) => {
          console.error("[Jobs] Background run failed", {
            jobId: job.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        results.push({ jobId: job.id, status: "success" });
      } catch (error) {
        results.push({
          jobId: job.id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  requestStop(jobId: string) {
    const handle = this.runningJobs.get(jobId);
    if (!handle) return false;
    handle.stopRequested = true;
    handle.abortController.abort("Stopped by request");
    return true;
  }

  private finishRun(
    state: PersistedJobState,
    runId: string,
    status: "success" | "error" | "cancelled",
    finishedAt: string,
    durationMs: number,
    changed?: boolean,
    error?: string,
  ) {
    const run = state.runs.find((item) => item.runId === runId);
    if (!run) return;
    run.status = status;
    run.finishedAt = finishedAt;
    run.durationMs = durationMs;
    run.changed = changed;
    run.error = error;
  }
}
