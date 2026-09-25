import { describe, expect, test } from "bun:test";
import { InternalPathwayState, PostgresPathwayState } from "@flowcore/pathways";
import {
  INTERACTIVE_WRITE_WAIT_MS,
  MAX_LOCAL_ONLY_EVENT_IDS,
  SharedPathwayState,
  awaitInteractiveWrite,
  awaitProcessed,
} from "../../src/pathway-state";
import {
  LOCAL_STATE_PATHWAYS,
  type PathwayStateHost,
  configurePathwayState,
} from "../../src/pathways";

/**
 * The cluster split (writer on one pod, handler on the other) cannot be staged
 * in one process, so these pin the two halves of the fix instead: the runtime
 * waits on a state every replica shares, and an interactive write answers
 * inside the FE's 25 s budget whether or not its projection has landed.
 */

const EVENT_ID = "0b9f4c1e-7d2a-4e8b-9c3f-1a2b3c4d5e6f";
// Never connected: PostgresPathwayState opens its pool lazily.
const UNREACHABLE_DB = { DATABASE_URL: "postgres://u:p@127.0.0.1:1/none" };
const FE_REQUEST_TIMEOUT_MS = 25_000;

function fakeHost() {
  const states: unknown[] = [];
  const subscriptions: {
    path: string;
    type: string;
    handler: (event: { eventId: string }) => void;
  }[] = [];
  const host: PathwayStateHost = {
    withPathwayState(state) {
      states.push(state);
    },
    subscribe(path, handler, type) {
      subscriptions.push({ path, type, handler });
    },
  };
  return { host, states, subscriptions };
}

function recordingState() {
  const processed: string[] = [];
  return {
    processed,
    state: {
      isProcessed: (id: string) => processed.includes(id),
      setProcessed: (id: string) => {
        processed.push(id);
      },
    },
  };
}

describe("configurePathwayState", () => {
  test("registers a Postgres-backed state shared across replicas", () => {
    const { host, states } = fakeHost();
    const state = configurePathwayState(host, UNREACHABLE_DB);
    expect(states).toEqual([state]);
    expect(state).toBeInstanceOf(SharedPathwayState);
    expect(state.shared).toBeInstanceOf(PostgresPathwayState);
  });

  test("keeps only the fire-and-forget flows in-process", async () => {
    const { host, subscriptions } = fakeHost();
    const state = configurePathwayState(host, UNREACHABLE_DB);
    expect(subscriptions.map((s) => s.path).sort()).toEqual(
      [...LOCAL_STATE_PATHWAYS].sort(),
    );
    expect(subscriptions.every((s) => s.type === "before")).toBe(true);
    // The "before" hook marks the event, so its setProcessed stays local —
    // reaching the unreachable Postgres here would reject.
    subscriptions[0]?.handler({ eventId: EVENT_ID });
    await state.setProcessed(EVENT_ID);
  });

  test("every local-only pathway is written fire-and-forget, so none is ever awaited", async () => {
    const source = await Bun.file("src/pathways.ts").text();
    const listStart = source.indexOf("export const LOCAL_STATE_PATHWAYS = [");
    const listBody = source.slice(
      listStart,
      source.indexOf("] as const", listStart),
    );
    const names = [...listBody.matchAll(/\b([A-Z_]+_PATHWAY)\b/g)].map(
      (m) => m[1] as string,
    );
    expect(names).toHaveLength(LOCAL_STATE_PATHWAYS.length);
    for (const name of names) {
      const calls = [...source.matchAll(new RegExp(`\\)\\(${name}, \\{`, "g"))];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // The write's input object runs up to the next writer method.
        const from = call.index ?? 0;
        const next = source.indexOf("\n      async ", from);
        const input = source.slice(from, next === -1 ? undefined : next);
        expect({
          name,
          fireAndForget: input.includes("fireAndForget: true"),
        }).toEqual({
          name,
          fireAndForget: true,
        });
      }
    }
  });

  test("createPathwayRuntime wires it before building the router", async () => {
    const source = await Bun.file("src/pathways.ts").text();
    const wired = source.indexOf("= configurePathwayState(");
    expect(wired).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(source.indexOf("new PathwayRouter("));
  });
});

describe("SharedPathwayState", () => {
  test("an unmarked event is recorded in the shared store", async () => {
    const shared = recordingState();
    const state = new SharedPathwayState(
      shared.state,
      new InternalPathwayState(),
    );
    await state.setProcessed(EVENT_ID);
    expect(shared.processed).toEqual([EVENT_ID]);
    expect(await state.isProcessed(EVENT_ID)).toBe(true);
  });

  test("a local-only event never touches the shared store", async () => {
    const shared = recordingState();
    const state = new SharedPathwayState(
      shared.state,
      new InternalPathwayState(),
    );
    state.markLocalOnly(EVENT_ID);
    await state.setProcessed(EVENT_ID);
    expect(shared.processed).toEqual([]);
    expect(await state.isProcessed(EVENT_ID)).toBe(true);
  });

  test("stranded local-only ids are bounded, oldest evicted first", async () => {
    const shared = recordingState();
    const state = new SharedPathwayState(
      shared.state,
      new InternalPathwayState(),
    );
    for (let i = 0; i <= MAX_LOCAL_ONLY_EVENT_IDS; i++) {
      state.markLocalOnly(`evt-${i}`);
    }
    expect(state.localOnlyCount).toBe(MAX_LOCAL_ONLY_EVENT_IDS);
    // The oldest fell out, so its marker now goes to the shared store…
    await state.setProcessed("evt-0");
    expect(shared.processed).toEqual(["evt-0"]);
    // …while the newest is still local.
    await state.setProcessed(`evt-${MAX_LOCAL_ONLY_EVENT_IDS}`);
    expect(shared.processed).toEqual(["evt-0"]);
  });

  test("a marker written by ANOTHER replica is visible here", async () => {
    const shared = recordingState();
    shared.processed.push(EVENT_ID);
    const state = new SharedPathwayState(
      shared.state,
      new InternalPathwayState(),
    );
    expect(await state.isProcessed(EVENT_ID)).toBe(true);
  });
});

describe("awaitInteractiveWrite", () => {
  test("a projection that lands answers as confirmed", async () => {
    let checks = 0;
    const result = await awaitInteractiveWrite(
      "test",
      { isProcessed: () => ++checks >= 3 },
      async () => [EVENT_ID],
      1_000,
    );
    expect(result).toEqual({ eventId: EVENT_ID, projectionPending: false });
  });

  test("a projection that outruns the deadline is pending, not a failure", async () => {
    const started = Date.now();
    const result = await awaitInteractiveWrite(
      "test",
      { isProcessed: () => false },
      async () => EVENT_ID,
      250,
    );
    expect(result).toEqual({ eventId: EVENT_ID, projectionPending: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a failed write still throws — nothing was recorded", async () => {
    await expect(
      awaitInteractiveWrite(
        "test",
        { isProcessed: () => true },
        async () => {
          throw new Error("fetch failed");
        },
        250,
      ),
    ).rejects.toThrow("fetch failed");
  });

  test("a write that returns no event id fails loudly instead of polling", async () => {
    await expect(
      awaitInteractiveWrite(
        "test",
        { isProcessed: () => false },
        async () => [],
        250,
      ),
    ).rejects.toThrow('Pathway write "test" returned no event id');
  });

  test("the default deadline fits inside the FE's request budget", () => {
    expect(INTERACTIVE_WRITE_WAIT_MS).toBeLessThan(FE_REQUEST_TIMEOUT_MS);
  });
});

describe("awaitProcessed", () => {
  test("resolves false at the deadline instead of throwing", async () => {
    expect(
      await awaitProcessed({ isProcessed: () => false }, EVENT_ID, 50, 10),
    ).toBe(false);
  });
});
