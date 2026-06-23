import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import { jobRuns, jobState } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import type { JobDefinition } from "./types";
import type {
  JobLatestItem,
  JobRunRecord,
  JobRunStatus,
  JobState,
  PersistedJobState,
} from "./types";

// Retained run history per job. job_runs is pruned to this on every save; the
// runner's in-memory state.runs is also capped here via compact().
const MAX_RUNS = 50;

function buildDefaultJobState(job: JobDefinition): JobState {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: true,
    lastRunStatus: "idle",
    latestItems: [],
    metrics: { runs: 0, successes: 0, failures: 0, newDataEvents: 0 },
  };
}

function defaultState(job: JobDefinition): PersistedJobState {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    job: buildDefaultJobState(job),
    runs: [],
  };
}

function compact(
  state: PersistedJobState,
  job: JobDefinition,
): PersistedJobState {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    job: {
      ...buildDefaultJobState(job),
      ...state.job,
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      latestItems: (state.job.latestItems ?? []).slice(0, 25).map((item) => ({
        ...item,
        bodyMarkdown: undefined,
      })),
    },
    runs: (state.runs ?? []).slice(0, MAX_RUNS),
  };
}

function toIso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

type JobStateRow = typeof jobState.$inferSelect;
type JobRunRow = typeof jobRuns.$inferSelect;

function rowToJobState(job: JobDefinition, row: JobStateRow): JobState {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: row.enabled,
    lastRunStatus: row.lastRunStatus as JobRunStatus,
    lastRunAt: toIso(row.lastRunAt),
    lastSuccessAt: toIso(row.lastSuccessAt),
    lastErrorAt: toIso(row.lastErrorAt),
    lastError: row.lastError ?? undefined,
    lastCheckedAt: toIso(row.lastCheckedAt),
    lastDurationMs: row.lastDurationMs ?? undefined,
    listingFingerprint: row.listingFingerprint ?? undefined,
    cursor: (row.cursor as JobState["cursor"]) ?? undefined,
    latestItems: (row.latestItems as JobLatestItem[] | null) ?? [],
    progress: (row.progress as JobState["progress"]) ?? undefined,
    metrics: (row.metrics as JobState["metrics"]) ?? {
      runs: 0,
      successes: 0,
      failures: 0,
      newDataEvents: 0,
    },
  };
}

export function jobStateValues(
  jobId: string,
  s: JobState,
): typeof jobState.$inferInsert {
  return {
    jobId,
    enabled: s.enabled,
    lastRunStatus: s.lastRunStatus,
    lastRunAt: toDate(s.lastRunAt),
    lastSuccessAt: toDate(s.lastSuccessAt),
    lastErrorAt: toDate(s.lastErrorAt),
    lastError: s.lastError ?? null,
    lastCheckedAt: toDate(s.lastCheckedAt),
    lastDurationMs: s.lastDurationMs ?? null,
    listingFingerprint: s.listingFingerprint ?? null,
    cursor: s.cursor ?? null,
    progress: s.progress ?? null,
    latestItems: s.latestItems ?? [],
    metrics: s.metrics,
    updatedAt: new Date(),
  };
}

function rowToRun(row: JobRunRow): JobRunRecord {
  return {
    runId: row.runId,
    jobId: row.jobId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: toIso(row.finishedAt),
    status: row.status as JobRunStatus,
    trigger: row.trigger as "manual" | "cron",
    args: (row.args as Record<string, unknown> | null) ?? undefined,
    error: row.error ?? undefined,
    durationMs: row.durationMs ?? undefined,
    changed: row.changed ?? undefined,
  };
}

export function runValues(run: JobRunRecord): typeof jobRuns.$inferInsert {
  return {
    runId: run.runId,
    jobId: run.jobId,
    startedAt: new Date(run.startedAt),
    finishedAt: toDate(run.finishedAt),
    status: run.status,
    trigger: run.trigger,
    args: run.args ?? null,
    error: run.error ?? null,
    durationMs: run.durationMs ?? null,
    changed: run.changed ?? null,
  };
}

/**
 * Per-job state store backed by Postgres (`job_state` + `job_runs`). Previously
 * this wrote one Usable memory fragment per job, which Usable re-chunked and
 * re-embedded on every PATCH — a heavy, near-static-content write storm. Moving
 * to Postgres makes each save a cheap upsert with zero embedding cost. The
 * public `load`/`loadAll`/`save` interface is unchanged so the JobRunner and the
 * jobs' `previous`/`checkpoint` usage keep working.
 */
export class JobStateStore {
  constructor(
    private readonly db: Database,
    private readonly jobs: JobDefinition[],
  ) {}

  private getJob(jobId: string) {
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }

  async load(jobId: string) {
    const job = this.getJob(jobId);
    const rows = await this.db
      .select()
      .from(jobState)
      .where(eq(jobState.jobId, jobId))
      .limit(1);
    const stateRow = rows[0];
    if (!stateRow) return { state: defaultState(job) };
    const runRows = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.jobId, jobId))
      .orderBy(desc(jobRuns.startedAt))
      .limit(MAX_RUNS);
    const state: PersistedJobState = {
      schemaVersion: 1,
      updatedAt: stateRow.updatedAt.toISOString(),
      job: rowToJobState(job, stateRow),
      runs: runRows.map(rowToRun),
    };
    return { state: compact(state, job) };
  }

  async save(input: { jobId: string; state: PersistedJobState }) {
    const job = this.getJob(input.jobId);
    const state = compact(input.state, job);

    const { jobId: _jobId, ...updateSet } = jobStateValues(
      input.jobId,
      state.job,
    );
    await this.db
      .insert(jobState)
      .values(jobStateValues(input.jobId, state.job))
      .onConflictDoUpdate({ target: jobState.jobId, set: updateSet });

    if (state.runs.length > 0) {
      await this.db
        .insert(jobRuns)
        .values(
          state.runs.map((run) => runValues({ ...run, jobId: input.jobId })),
        )
        .onConflictDoUpdate({
          target: jobRuns.runId,
          set: {
            status: sql`excluded.status`,
            finishedAt: sql`excluded.finished_at`,
            error: sql`excluded.error`,
            durationMs: sql`excluded.duration_ms`,
            changed: sql`excluded.changed`,
          },
        });
      // Keep only the newest MAX_RUNS per job.
      await this.db.execute(sql`
        delete from job_runs
        where job_id = ${input.jobId}
          and run_id not in (
            select run_id from job_runs
            where job_id = ${input.jobId}
            order by started_at desc
            limit ${MAX_RUNS}
          )
      `);
    }

    return { state };
  }

  async loadAll() {
    const stateRows = await this.db.select().from(jobState);
    const byId = new Map(stateRows.map((row) => [row.jobId, row]));
    const jobs: Record<string, JobState> = {};
    for (const job of this.jobs) {
      const row = byId.get(job.id);
      jobs[job.id] = row ? rowToJobState(job, row) : buildDefaultJobState(job);
    }
    const runRows = await this.db
      .select()
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt))
      .limit(MAX_RUNS);
    return {
      state: {
        schemaVersion: 1 as const,
        updatedAt: new Date().toISOString(),
        jobs,
        runs: runRows.map(rowToRun),
      },
    };
  }
}

export function createRunId() {
  return randomUUID();
}
