import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresActivityCacheStore } from "../../src/ais/activity-cache";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let ctx: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  try {
    const c = createDb(DATABASE_URL);
    await runMigrations(c.db, c.client);
    await c.client`DELETE FROM ais_activity_cache WHERE key LIKE 'test:%'`;
    ctx = c;
  } catch (error) {
    console.warn(
      "[activity-cache-store.test] skipping — could not connect to test DB",
      error instanceof Error ? error.message : error,
    );
  }
});

afterAll(async () => {
  if (!ctx) return;
  await ctx.client`DELETE FROM ais_activity_cache WHERE key LIKE 'test:%'`;
  await ctx.client.end();
});

describe("PostgresActivityCacheStore", () => {
  test("round-trips a gzipped body byte for byte", async () => {
    if (!ctx) return;
    const store = new PostgresActivityCacheStore(ctx.db, 1_000_000);
    const body = new Uint8Array([0x1f, 0x8b, 0, 255, 1, 2, 3]);
    await store.put("test:a", body);
    expect(await store.get("test:a")).toEqual(body);
    expect(await store.get("test:missing")).toBeNull();
  });

  test("a second put of the same key keeps the first body (immutable windows)", async () => {
    if (!ctx) return;
    const store = new PostgresActivityCacheStore(ctx.db, 1_000_000);
    await store.put("test:b", new Uint8Array([1]));
    await store.put("test:b", new Uint8Array([2]));
    expect(await store.get("test:b")).toEqual(new Uint8Array([1]));
  });

  test("stays within its byte budget, dropping the least recently hit first", async () => {
    if (!ctx) return;
    await ctx.client`DELETE FROM ais_activity_cache WHERE key LIKE 'test:%'`;
    // Budget of 250 bytes holds two 100-byte bodies, not three.
    const store = new PostgresActivityCacheStore(ctx.db, 250);
    const body = new Uint8Array(100);
    await store.put("test:old", body);
    await store.put("test:mid", body);
    // a hit makes "old" the most recently used
    await store.get("test:old");
    await store.put("test:new", body);
    const rows = await ctx.client<{ key: string }[]>`
      SELECT key FROM ais_activity_cache WHERE key LIKE 'test:%' ORDER BY key`;
    expect(rows.map((r) => r.key)).toEqual(["test:new", "test:old"]);
  });
});
