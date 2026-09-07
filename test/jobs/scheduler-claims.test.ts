import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { JobCronClaims } from "../../src/jobs/cron-claims";
import type { JobRunner } from "../../src/jobs/runner";
import { JobScheduler } from "../../src/jobs/scheduler";
import type { JobDefinition } from "../../src/jobs/types";

/**
 * Stands in for the job_cron_claims primary key: the first caller to ask for a
 * given (job, bucket) wins, every later caller loses.
 */
function sharedClaims() {
  const taken = new Set<string>();
  const attempts: string[] = [];
  return {
    attempts,
    store: {
      claim: async (jobId: string, bucket: string) => {
        const key = `${jobId}@${bucket}`;
        attempts.push(key);
        if (taken.has(key)) return false;
        taken.add(key);
        return true;
      },
    } as unknown as JobCronClaims,
  };
}

function runnerFor(job: JobDefinition, runs: string[]) {
  return {
    definitions: () => [job],
    runJob: async (jobId: string) => {
      runs.push(jobId);
      return undefined as never;
    },
  } as unknown as JobRunner;
}

const everyMinute: JobDefinition = {
  id: "test-job",
  name: "Test job",
  schedule: "* * * * *",
  inputSchema: z.object({}),
  execute: async () => ({
    checkedAt: new Date().toISOString(),
    changed: false,
    latestItems: [],
    message: "noop",
  }),
};

const env = {
  JOB_SCHEDULER_ENABLED: true,
  JOB_SCHEDULER_TICK_MS: 1_000,
} as never;

/** `tick` is private; the scheduler exposes no other way to drive one pass. */
function tickOnce(scheduler: JobScheduler) {
  return (scheduler as unknown as { tick: () => Promise<void> }).tick();
}

describe("JobScheduler cross-replica claims", () => {
  test("only one replica runs a job for the same minute", async () => {
    // Reproduces the 2026-09-04 finding: with replicas: 2 and an in-memory
    // guard only, every cron job fired twice a few seconds apart, doubling our
    // request rate against every upstream we scrape.
    const runs: string[] = [];
    const { store } = sharedClaims();
    const replicaA = new JobScheduler(env, runnerFor(everyMinute, runs), store);
    const replicaB = new JobScheduler(env, runnerFor(everyMinute, runs), store);

    await tickOnce(replicaA);
    await tickOnce(replicaB);

    expect(runs).toEqual(["test-job"]);
  });

  test("a replica still runs the job when it wins the claim", async () => {
    const runs: string[] = [];
    const { store } = sharedClaims();
    const scheduler = new JobScheduler(
      env,
      runnerFor(everyMinute, runs),
      store,
    );

    await tickOnce(scheduler);

    expect(runs).toEqual(["test-job"]);
  });

  test("the in-memory guard still short-circuits before hitting the database", async () => {
    const runs: string[] = [];
    const { store, attempts } = sharedClaims();
    const scheduler = new JobScheduler(
      env,
      runnerFor(everyMinute, runs),
      store,
    );

    await tickOnce(scheduler);
    await tickOnce(scheduler);

    expect(runs).toEqual(["test-job"]);
    // Second tick is in the same minute bucket, so it must not re-query.
    expect(attempts).toHaveLength(1);
  });

  test("a transient claim error is retried on the next tick in the same minute", async () => {
    // The in-memory guard is burned before the claim is attempted, so an error
    // has to hand the bucket back — otherwise one DB blip costs an hourly job
    // its whole hour, not just that tick.
    const runs: string[] = [];
    const attempts: string[] = [];
    let failNext = true;
    const flaky = {
      claim: async (jobId: string, bucket: string) => {
        attempts.push(`${jobId}@${bucket}`);
        if (failNext) {
          failNext = false;
          throw new Error("connection terminated unexpectedly");
        }
        return true;
      },
    } as unknown as JobCronClaims;
    const scheduler = new JobScheduler(
      env,
      runnerFor(everyMinute, runs),
      flaky,
    );

    await tickOnce(scheduler);
    await tickOnce(scheduler);

    expect(runs).toEqual(["test-job"]);
    // Guards against passing for the wrong reason: both ticks must have been in
    // the same minute, or the retry proves nothing.
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
  });

  test("a failing claim skips the tick instead of running twice", async () => {
    const runs: string[] = [];
    const failing = {
      claim: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as JobCronClaims;
    const scheduler = new JobScheduler(
      env,
      runnerFor(everyMinute, runs),
      failing,
    );

    await tickOnce(scheduler);

    expect(runs).toEqual([]);
  });
});
