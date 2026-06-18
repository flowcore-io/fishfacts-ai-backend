import { randomUUID } from "node:crypto";
import type { Env } from "@/env";
import type { UsableApiClient } from "@/usable/client";
import type { JobDefinition } from "./types";
import type { JobRunRecord, JobState, PersistedJobState } from "./types";

// Cap retained run history per job-state fragment. Each save rewrites the whole
// fragment (re-chunked + re-embedded by Usable), so an unbounded runs[] makes
// every PATCH progressively larger/slower (J-meldinger had grown to ~1.6k lines).
const MAX_RUNS = 25;

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

function safeJson<T>(value?: string): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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

export class JobStateStore {
  constructor(
    private readonly env: Env,
    private readonly usable: UsableApiClient,
    private readonly jobs: JobDefinition[],
  ) {}

  private key(jobId: string) {
    return `fishfacts-ai-backend-job-state-${jobId}`;
  }

  private getJob(jobId: string) {
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }

  async load(jobId: string) {
    const job = this.getJob(jobId);
    const key = this.key(jobId);
    const fragment = await this.usable
      .getFragmentByKey(this.env.USABLE_WORKSPACE_ID, key)
      .catch(() => null);
    return {
      fragmentId: fragment?.id ?? null,
      key,
      state: compact(
        safeJson<PersistedJobState>(fragment?.content) ?? defaultState(job),
        job,
      ),
    };
  }

  async save(input: {
    jobId: string;
    fragmentId: string | null;
    state: PersistedJobState;
  }) {
    const job = this.getJob(input.jobId);
    const key = this.key(input.jobId);
    const state = compact(input.state, job);
    const content = JSON.stringify(state, null, 2);
    const title = `FishFacts Job State: ${job.name}`;
    const tags = [
      "fishfacts",
      "job-system",
      "state",
      `job:${job.id}`,
      `state-key:${key}`,
    ];
    if (!input.fragmentId) {
      try {
        const created = await this.usable.createFragment({
          workspaceId: this.env.USABLE_WORKSPACE_ID,
          fragmentTypeId: this.env.JOB_STATE_FRAGMENT_TYPE_ID,
          key,
          title,
          summary: `State for scheduled job ${job.id}`,
          content,
          tags,
        });
        return { fragmentId: created?.id ?? null, key, state };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("409")) throw error;
        const existing = await this.usable.getFragmentByKey(
          this.env.USABLE_WORKSPACE_ID,
          key,
        );
        if (!existing) throw error;
        await this.usable.updateFragment(existing.id, {
          fragmentTypeId: this.env.JOB_STATE_FRAGMENT_TYPE_ID,
          title,
          summary: `State for scheduled job ${job.id}`,
          content,
          tags,
        });
        return { fragmentId: existing.id, key, state };
      }
    }
    await this.usable.updateFragment(input.fragmentId, {
      fragmentTypeId: this.env.JOB_STATE_FRAGMENT_TYPE_ID,
      title,
      summary: `State for scheduled job ${job.id}`,
      content,
      tags,
    });
    return { fragmentId: input.fragmentId, key, state };
  }

  async loadAll() {
    const entries = await Promise.all(
      this.jobs.map(async (job) => ({ job, loaded: await this.load(job.id) })),
    );
    const jobs: Record<string, JobState> = {};
    const runs: JobRunRecord[] = [];
    const fragmentIds: Record<string, string | null> = {};
    for (const entry of entries) {
      jobs[entry.job.id] = entry.loaded.state.job;
      runs.push(...entry.loaded.state.runs);
      fragmentIds[entry.job.id] = entry.loaded.fragmentId;
    }
    runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return {
      fragmentIds,
      state: {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        jobs,
        runs: runs.slice(0, MAX_RUNS),
      },
    };
  }
}

export function createRunId() {
  return randomUUID();
}
