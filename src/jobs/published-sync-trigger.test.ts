import { describe, expect, test } from "bun:test";
import {
  PUBLISHED_SYNC_JOB_ID,
  PublishedSyncTrigger,
} from "./published-sync-trigger";
import { JobAlreadyRunningError, type JobRunner } from "./runner";

const DEBOUNCE_MS = 10;
// Larger than any pre-retry assertion window below, so a backoff retry can
// never fire inside a phase that asserts the pre-retry call count.
const RETRY_BASE_MS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A runner double that records calls and lets the test control when each
 * run finishes (or fails). Only `runJob` is consulted by the trigger.
 */
function fakeRunner(
  behaviour: (call: number) => Promise<void> = () => Promise.resolve(),
) {
  const calls: Array<{ jobId: string; trigger: string }> = [];
  const runner = {
    runJob: (jobId: string, trigger: string) => {
      calls.push({ jobId, trigger });
      return behaviour(calls.length);
    },
  } as unknown as JobRunner;
  return { runner, calls };
}

function trigger(runner?: JobRunner) {
  const t = new PublishedSyncTrigger(DEBOUNCE_MS, RETRY_BASE_MS);
  if (runner) t.attachRunner(runner);
  return t;
}

describe("PublishedSyncTrigger", () => {
  test("a burst of schedules collapses into one event-triggered run", async () => {
    const { runner, calls } = fakeRunner();
    const t = trigger(runner);

    t.schedule("approval.recorded");
    t.schedule("approval.recorded");
    t.schedule("decline:reject");
    await sleep(DEBOUNCE_MS * 4);

    expect(calls).toEqual([{ jobId: PUBLISHED_SYNC_JOB_ID, trigger: "event" }]);
  });

  test("a schedule arriving mid-run causes a second run, not a drop", async () => {
    let release: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, calls } = fakeRunner((call) =>
      call === 1 ? firstRun : Promise.resolve(),
    );
    const t = trigger(runner);

    t.schedule("approval.recorded");
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(1);

    // The published set changes again while the first pass is still reading.
    t.schedule("decline:reject");
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(1);

    release?.();
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(2);
  });

  test("schedules before attachRunner are held, not lost", async () => {
    const { runner, calls } = fakeRunner();
    const t = trigger();

    t.schedule("approval.recorded");
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(0);

    t.attachRunner(runner);
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(1);
  });

  test("a lock collision retries without spending the failure budget", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call === 1
        ? Promise.reject(new JobAlreadyRunningError(PUBLISHED_SYNC_JOB_ID))
        : Promise.resolve(),
    );
    const t = trigger(runner);

    t.schedule("approval.recorded");
    await sleep(DEBOUNCE_MS * 6);

    expect(calls.length).toBe(2);
  });

  test("a transient failure retries on the backoff instead of dropping", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call === 1 ? Promise.reject(new Error("usable 502")) : Promise.resolve(),
    );
    const t = trigger(runner);

    expect(() => t.schedule("decline:reject")).not.toThrow();
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(1);

    // attempt 1 re-arms at 1 × RETRY_BASE_MS — the decline sync must land.
    await sleep(RETRY_BASE_MS + DEBOUNCE_MS * 4);
    expect(calls.length).toBe(2);
  });

  test("retries are bounded, and a NEW schedule restores the budget", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call <= 6 ? Promise.reject(new Error("usable down")) : Promise.resolve(),
    );
    const t = trigger(runner);

    t.schedule("approval.recorded");
    // 1 initial + 5 budgeted retries at 1×..5× base, then it stops trying.
    const backoffTotal = RETRY_BASE_MS * (1 + 2 + 3 + 4 + 5);
    await sleep(backoffTotal + DEBOUNCE_MS * 10);
    expect(calls.length).toBe(6);

    // Nothing further without a new change…
    await sleep(RETRY_BASE_MS * 6);
    expect(calls.length).toBe(6);

    // …but the next change gets a fresh budget and syncs.
    t.schedule("decline:mark_duplicate");
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(7);
  });
});
