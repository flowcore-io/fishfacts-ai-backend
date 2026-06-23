import type { Database } from "@/db/client";
import { jobRuns, jobState } from "@/db/schema";
import type { Env } from "@/env";
import type { UsableApiClient } from "@/usable/client";
import { jobStateValues, runValues } from "./state-store";
import type { JobDefinition, PersistedJobState } from "./types";

const MAX_SEED_RUNS = 50;

function fragmentKey(jobId: string) {
  return `fishfacts-ai-backend-job-state-${jobId}`;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * One-time migration: seed the Postgres job-state tables from the legacy Usable
 * job-state fragments. MUST run after migrations and BEFORE the scheduler /
 * backfill supervisor start — the resume-dependent jobs (jmelding, gillnet,
 * vorn, fiskistofa) keep their cursor + listingFingerprint in the fragment, so
 * starting them on empty state would lose the resume point and re-process.
 *
 * Idempotent + replicas-safe: only seeds jobs that have NO `job_state` row yet,
 * and inserts ON CONFLICT DO NOTHING. After the first boot every job has a row,
 * so this becomes a no-op (and never overwrites live Postgres state). A per-job
 * failure (e.g. transient Usable 5xx) is logged and that job starts fresh rather
 * than blocking boot.
 */
export async function seedJobStateFromUsable(
  db: Database,
  usable: UsableApiClient,
  env: Env,
  jobs: JobDefinition[],
): Promise<void> {
  const existing = await db.select({ jobId: jobState.jobId }).from(jobState);
  const have = new Set(existing.map((row) => row.jobId));
  const missing = jobs.filter((job) => !have.has(job.id));
  if (missing.length === 0) return;

  console.log(
    `[Jobs] seeding ${missing.length} job-state row(s) from Usable fragments…`,
  );
  for (const job of missing) {
    try {
      const fragment = await withRetry(() =>
        usable.getFragmentByKey(env.USABLE_WORKSPACE_ID, fragmentKey(job.id)),
      );
      if (!fragment?.content) {
        console.log(`[Jobs] no Usable job-state for ${job.id}; starting fresh`);
        continue;
      }
      const parsed = JSON.parse(fragment.content) as PersistedJobState;
      if (!parsed?.job) {
        console.log(
          `[Jobs] unparseable job-state for ${job.id}; starting fresh`,
        );
        continue;
      }

      await db
        .insert(jobState)
        .values(jobStateValues(job.id, parsed.job))
        .onConflictDoNothing();

      const runs = (parsed.runs ?? []).slice(0, MAX_SEED_RUNS);
      if (runs.length > 0) {
        await db
          .insert(jobRuns)
          .values(runs.map((run) => runValues({ ...run, jobId: job.id })))
          .onConflictDoNothing();
      }
      console.log(`[Jobs] seeded ${job.id} from Usable (${runs.length} runs)`);
    } catch (err) {
      console.error(
        `[Jobs] failed to seed ${job.id} from Usable (starts fresh)`,
        {
          message: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}
