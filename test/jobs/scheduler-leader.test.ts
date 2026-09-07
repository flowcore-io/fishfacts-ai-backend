import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { PostgresLeaderLock } from "../../src/db/leader-lock";
import type { JobRunner } from "../../src/jobs/runner";
import { JobScheduler } from "../../src/jobs/scheduler";
import type { JobDefinition } from "../../src/jobs/types";

function runnerFor(job: JobDefinition, runs: string[]) {
  return {
    definitions: () => [job],
    runJob: async (jobId: string) => {
      runs.push(jobId);
      return undefined as never;
    },
  } as unknown as JobRunner;
}

function lockThatAnswers(answers: boolean[]) {
  let index = 0;
  const released: number[] = [];
  return {
    released,
    lock: {
      isLeader: async () => answers[Math.min(index++, answers.length - 1)],
      release: () => {
        released.push(index);
      },
    } as unknown as PostgresLeaderLock,
  };
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

describe("JobScheduler leader election", () => {
  test("the leader pod runs its due jobs", async () => {
    const runs: string[] = [];
    const { lock } = lockThatAnswers([true]);
    const scheduler = new JobScheduler(env, runnerFor(everyMinute, runs), lock);

    await tickOnce(scheduler);

    expect(runs).toEqual(["test-job"]);
  });

  test("a follower pod runs nothing", async () => {
    // Reproduces the 2026-09-04 finding: the scheduler runs in every pod and
    // its "already fired" guard is per-process, so at replicas: 2 every job
    // fired twice against every upstream we scrape.
    const runs: string[] = [];
    const { lock } = lockThatAnswers([false]);
    const scheduler = new JobScheduler(env, runnerFor(everyMinute, runs), lock);

    await tickOnce(scheduler);

    expect(runs).toEqual([]);
  });

  test("two replicas sharing one lock run a due job exactly once", async () => {
    const runs: string[] = [];
    const leader = lockThatAnswers([true]);
    const follower = lockThatAnswers([false]);
    const replicaA = new JobScheduler(
      env,
      runnerFor(everyMinute, runs),
      leader.lock,
    );
    const replicaB = new JobScheduler(
      env,
      runnerFor(everyMinute, runs),
      follower.lock,
    );

    await tickOnce(replicaA);
    await tickOnce(replicaB);

    expect(runs).toEqual(["test-job"]);
  });

  test("leadership is re-checked every tick, not latched at startup", async () => {
    // A pod that starts as a follower must pick the work up when the leader
    // dies, without a restart. Ticking follower-then-leader also proves the
    // check is not cached: the first tick returns before the in-memory guard is
    // touched, so the second is free to run in the same minute.
    const runs: string[] = [];
    const { lock } = lockThatAnswers([false, true]);
    const scheduler = new JobScheduler(env, runnerFor(everyMinute, runs), lock);

    await tickOnce(scheduler);
    expect(runs).toEqual([]);

    await tickOnce(scheduler);
    expect(runs).toEqual(["test-job"]);
  });

  test("stop() releases the lock so another pod can take over", async () => {
    const runs: string[] = [];
    const { lock, released } = lockThatAnswers([true]);
    const scheduler = new JobScheduler(env, runnerFor(everyMinute, runs), lock);

    scheduler.stop();

    expect(released).toHaveLength(1);
  });
});
