import { describe, expect, test } from "bun:test";
import {
  ActivityResponseCache,
  ByteBoundedLru,
} from "../../src/ais/activity-cache";

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe("ByteBoundedLru", () => {
  test("never holds more than its byte budget, evicting least recently used first", () => {
    const lru = new ByteBoundedLru(1000);
    lru.set("a", bytes(200), Number.POSITIVE_INFINITY);
    lru.set("b", bytes(200), Number.POSITIVE_INFINITY);
    lru.set("c", bytes(200), Number.POSITIVE_INFINITY);
    lru.set("d", bytes(200), Number.POSITIVE_INFINITY);
    lru.get("a", 0); // a is now the most recently used
    lru.set("e", bytes(250), Number.POSITIVE_INFINITY);
    expect(lru.sizeBytes).toBeLessThanOrEqual(1000);
    expect(lru.get("b", 0)).toBeNull();
    expect(lru.get("a", 0)).not.toBeNull();
    expect(lru.get("e", 0)).not.toBeNull();
  });

  test("a body over a quarter of the budget is not held at all", () => {
    const lru = new ByteBoundedLru(1000);
    lru.set("small", bytes(100), Number.POSITIVE_INFINITY);
    lru.set("big", bytes(251), Number.POSITIVE_INFINITY);
    expect(lru.get("big", 0)).toBeNull();
    expect(lru.get("small", 0)).not.toBeNull();
    expect(lru.sizeBytes).toBe(100);
  });

  test("replacing a key does not double-count its bytes", () => {
    const lru = new ByteBoundedLru(1000);
    lru.set("a", bytes(200), Number.POSITIVE_INFINITY);
    lru.set("a", bytes(100), Number.POSITIVE_INFINITY);
    expect(lru.sizeBytes).toBe(100);
    expect(lru.size).toBe(1);
  });

  test("expired entries are gone and give their bytes back", () => {
    const lru = new ByteBoundedLru(1000);
    lru.set("a", bytes(200), 10);
    expect(lru.get("a", 9)).not.toBeNull();
    expect(lru.get("a", 10)).toBeNull();
    expect(lru.sizeBytes).toBe(0);
  });
});

describe("ActivityResponseCache", () => {
  test("a recent window is rebuilt after its TTL", async () => {
    let now = 0;
    let builds = 0;
    const cache = new ActivityResponseCache({
      store: null,
      memoryMaxBytes: 10_000,
      mutableTtlMs: 300_000,
      now: () => now,
    });
    const build = async () => {
      builds++;
      return { fresh: bytes(10, 1), stored: bytes(10, 2) };
    };
    expect((await cache.get("k", false, build)).source).toBe("built");
    now = 299_999;
    expect((await cache.get("k", false, build)).source).toBe("memory");
    now = 300_000;
    expect((await cache.get("k", false, build)).source).toBe("built");
    expect(builds).toBe(2);
  });

  test("a failed build is not cached and every waiter sees the failure", async () => {
    const cache = new ActivityResponseCache({
      store: null,
      memoryMaxBytes: 10_000,
      mutableTtlMs: 300_000,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const failing = async () => {
      await gate;
      throw new Error("boom");
    };
    const a = cache.get("k", true, failing);
    const b = cache.get("k", true, failing);
    release();
    const settled = await Promise.allSettled([a, b]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(
      settled.map((r) => (r.status === "rejected" ? String(r.reason) : "")),
    ).toEqual(["Error: boom", "Error: boom"]);
    const ok = await cache.get("k", true, async () => ({
      fresh: bytes(1),
      stored: bytes(1),
    }));
    expect(ok.source).toBe("built");
  });

  test("a store outage costs a rebuild, never an error", async () => {
    const cache = new ActivityResponseCache({
      store: {
        get: async () => {
          throw new Error("pg down");
        },
        put: async () => {
          throw new Error("pg down");
        },
      },
      memoryMaxBytes: 10_000,
      mutableTtlMs: 300_000,
    });
    const r = await cache.get("k", true, async () => ({
      fresh: bytes(3),
      stored: bytes(3),
    }));
    expect(r.source).toBe("built");
  });
});
