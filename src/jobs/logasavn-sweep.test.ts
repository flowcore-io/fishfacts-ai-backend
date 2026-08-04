import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import { INDEX_FRAGMENT_KEY } from "@/logasavn/index-fragment";
import type { UsableFragment } from "@/usable/client";
import {
  type LogasavnSweepUsable,
  createLogasavnSweepJob,
} from "./logasavn-sweep";

const env = {
  LOGASAVN_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
  LOGASAVN_FRAGMENT_TYPE_ID: "22222222-2222-4222-8222-222222222222",
  USABLE_WORKSPACE_ID: "33333333-3333-4333-8333-333333333333",
  LOGASAVN_INDEX_FRAGMENT_TYPE_ID: "44444444-4444-4444-8444-444444444444",
} as unknown as Env;

const context = {
  signal: new AbortController().signal,
  isStopRequested: () => false,
  reportProgress: () => {},
};

/** One real statute, so the sweep has a candidate and does not refuse to land. */
const CORPUS: UsableFragment[] = [
  {
    id: "f1",
    title: "Kunngerð nr. 35 (2026)",
    tags: [],
    content: `---
url: https://logir.fo/Kunngerd/35-fra-2026
validity_status: Galdandi
---

### § 2.

- **1)**60°57'20"N - 07°57'00"V
- **2)**61°03'00"N - 07°57'00"V
- **3)**61°15'30"N - 08°16'00"V
- **4)**60°57'20"N - 07°57'00"V`,
  },
];

type Call =
  | { kind: "create"; content: string }
  | { kind: "update"; id: string; content: string };

function fakeUsable(
  existing: UsableFragment | null,
  overrides: Partial<LogasavnSweepUsable> = {},
): { usable: LogasavnSweepUsable; calls: Call[] } {
  const calls: Call[] = [];
  const usable: LogasavnSweepUsable = {
    listFragments: async () => CORPUS,
    getFragmentByKey: async () => existing,
    createFragment: async (input) => {
      calls.push({ kind: "create", content: input.content });
      return { id: "new-id", key: input.key };
    },
    updateFragment: async (id, input) => {
      calls.push({ kind: "update", id, content: input.content ?? "" });
      return { id };
    },
    ...overrides,
  };
  return { usable, calls };
}

describe("publishing the index", () => {
  // The bug this exists to prevent, found in production: the index is ~117 KB
  // and POST refuses a payload that size while PATCH accepts it. The create
  // branch runs once in the lifetime of an environment, so nothing had ever
  // exercised it — the first real run failed, and the job could only publish
  // because a placeholder had been made by hand.
  test("a first run creates a SMALL stub, then writes the content by update", async () => {
    const { usable, calls } = fakeUsable(null);

    await createLogasavnSweepJob(env, usable)(undefined, {}, context);

    expect(calls.map((c) => c.kind)).toEqual(["create", "update"]);
    const [create, update] = calls as [Call & { kind: "create" }, Call];
    // The whole point: the bulk never goes through create.
    expect(create.content.length).toBeLessThan(500);
    expect(update.content).toContain("Lógasavn coordinate index");
    expect(update.content.length).toBeGreaterThan(create.content.length);
  });

  test("an existing index is updated in place, never re-created", async () => {
    const { usable, calls } = fakeUsable({ id: "existing-id" });

    await createLogasavnSweepJob(env, usable)(undefined, {}, context);

    expect(calls.map((c) => c.kind)).toEqual(["update"]);
    expect((calls[0] as { id: string }).id).toBe("existing-id");
  });

  test("a 409 from another writer adopts their fragment rather than failing", async () => {
    // Two sweeps racing on an empty workspace. Losing the race is not an error;
    // refusing to write the content would be.
    let byKey: UsableFragment | null = null;
    const { usable, calls } = fakeUsable(null, {
      getFragmentByKey: async () => byKey,
      createFragment: async () => {
        byKey = { id: "theirs" };
        throw new Error("Usable API HTTP 409: duplicate key");
      },
    });

    await createLogasavnSweepJob(env, usable)(undefined, {}, context);

    expect(calls.map((c) => c.kind)).toEqual(["update"]);
    expect((calls[0] as { id: string }).id).toBe("theirs");
  });

  test("a create that yields no id fails loudly instead of leaving a stub", async () => {
    // A page reading "Being populated" that nothing ever fills looks exactly
    // like a scan that found nothing.
    const { usable } = fakeUsable(null, { createFragment: async () => null });

    await expect(
      createLogasavnSweepJob(env, usable)(undefined, {}, context),
    ).rejects.toThrow(/cannot write its content/);
  });

  test("a dry run publishes nothing at all", async () => {
    const { usable, calls } = fakeUsable(null);

    const result = await createLogasavnSweepJob(env, usable)(
      undefined,
      { dryRun: true },
      context,
    );

    expect(calls).toEqual([]);
    expect(result.message).toContain("Dry run");
  });

  test("keys on the stable index key, so runs rewrite rather than pile up", async () => {
    const { usable, calls } = fakeUsable(null);

    await createLogasavnSweepJob(env, usable)(undefined, {}, context);

    expect(calls[0]).toMatchObject({ kind: "create" });
    // The key the skill points at; a drift here silently orphans the index.
    expect(INDEX_FRAGMENT_KEY).toBe("logasavn-coordinate-index");
  });
});
