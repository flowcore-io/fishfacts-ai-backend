import { type JobStateStore, createRunId } from "./state-store";
import type { JobDefinition, PersistedJobState } from "./types";

type RunningJobHandle = {
  abortController: AbortController;
  stopRequested: boolean;
};

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
    const loaded = await this.stateStore.load(jobId);
    const state = loaded.state;
    const previousJobState = structuredClone(state.job);
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
    let persisted = await this.stateStore.save({
      jobId,
      fragmentId: loaded.fragmentId,
      state,
    });
    let completed:
      | {
          fragmentId: string | null;
          state: PersistedJobState;
          result: Awaited<ReturnType<JobDefinition["execute"]>>;
        }
      | undefined;
    let progressSaveChain = Promise.resolve();
    const persistProgress = () => {
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
    const promise = (async () => {
      try {
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
        const finishedAt = new Date().toISOString();
        await progressSaveChain.catch(() => undefined);
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
        persisted = await this.stateStore.save({
          jobId,
          fragmentId: persisted.fragmentId,
          state: nextState,
        });
        completed = {
          fragmentId: persisted.fragmentId,
          state: persisted.state,
          result,
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        await progressSaveChain.catch(() => undefined);
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
        await this.stateStore.save({
          jobId,
          fragmentId: persisted.fragmentId,
          state: nextState,
        });
        throw new Error(message);
      } finally {
        this.runningJobs.delete(jobId);
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
