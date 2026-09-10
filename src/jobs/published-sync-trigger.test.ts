import { describe, expect, test } from "bun:test";
import {
  PUBLISHED_SYNC_JOB_ID,
  PublishedSyncTrigger,
} from "./published-sync-trigger";
import type { JobRunner } from "./runner";

const DEBOUNCE_MS = 10;

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

describe("PublishedSyncTrigger", () => {
  test("a burst of schedules collapses into one event-triggered run", async () => {
    const { runner, calls } = fakeRunner();
    const trigger = new PublishedSyncTrigger(DEBOUNCE_MS);
    trigger.attachRunner(runner);

    trigger.schedule("approval.recorded");
    trigger.schedule("approval.recorded");
    trigger.schedule("decline:reject");
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
    const trigger = new PublishedSyncTrigger(DEBOUNCE_MS);
    trigger.attachRunner(runner);

    trigger.schedule("approval.recorded");
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(1);

    // The published set changes again while the first pass is still reading.
    trigger.schedule("decline:reject");
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(1);

    release?.();
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(2);
  });

  test("schedules before attachRunner are held, not lost", async () => {
    const { runner, calls } = fakeRunner();
    const trigger = new PublishedSyncTrigger(DEBOUNCE_MS);

    trigger.schedule("approval.recorded");
    await sleep(DEBOUNCE_MS * 2);
    expect(calls.length).toBe(0);

    trigger.attachRunner(runner);
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(1);
  });

  test("an already-running collision retries instead of dropping", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call === 1
        ? Promise.reject(
            new Error(`Job ${PUBLISHED_SYNC_JOB_ID} is already running`),
          )
        : Promise.resolve(),
    );
    const trigger = new PublishedSyncTrigger(DEBOUNCE_MS);
    trigger.attachRunner(runner);

    trigger.schedule("approval.recorded");
    await sleep(DEBOUNCE_MS * 6);

    expect(calls.length).toBe(2);
  });

  test("a failed run neither throws into the caller nor wedges the trigger", async () => {
    const { runner, calls } = fakeRunner((call) =>
      call === 1 ? Promise.reject(new Error("usable 502")) : Promise.resolve(),
    );
    const trigger = new PublishedSyncTrigger(DEBOUNCE_MS);
    trigger.attachRunner(runner);

    expect(() => trigger.schedule("approval.recorded")).not.toThrow();
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(1);

    // A hard failure is logged and dropped; the NEXT change still syncs.
    trigger.schedule("decline:mark_duplicate");
    await sleep(DEBOUNCE_MS * 4);
    expect(calls.length).toBe(2);
  });
});
