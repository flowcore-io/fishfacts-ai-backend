import { afterAll, describe, expect, test } from "bun:test";
import { PostgresActivityCacheStore } from "../../src/ais/activity-cache";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

/**
 * A test DB is CONFIGURED when TEST_DATABASE_URL is set or this is CI. Then a
 * failed connect or migration fails this file: a configured database that
 * cannot be reached is a broken check, never a pass. Unconfigured (a laptop
 * with no Postgres) the suite is reported as skipped, not as passed.
 */
const CONFIGURED = Boolean(process.env.TEST_DATABASE_URL || process.env.CI);
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

async function connect() {
  const c = createDb(DATABASE_URL);
  await runMigrations(c.db, c.client);
  await c.client`DELETE FROM ais_activity_cache WHERE key LIKE 'test:%'`;
  return c;
}

async function connectOrSkip(): Promise<ReturnType<typeof createDb> | null> {
  if (CONFIGURED) return connect();
  try {
    return await connect();
  } catch (error) {
    console.warn(
      "[activity-cache-store.test] SKIPPED: no test DB configured and none at the default URL",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const ctx = await connectOrSkip();
// Only reached inside the suite, which is skipped when ctx is null.
const db = () => (ctx as NonNullable<typeof ctx>).db;
const client = () => (ctx as NonNullable<typeof ctx>).client;

afterAll(async () => {
  if (!ctx) return;
  await ctx.client`DELETE FROM ais_activity_cache WHERE key LIKE 'test:%'`;
  await ctx.client.end();
});

describe.skipIf(!ctx)("PostgresActivityCacheStore", () => {
  test("round-trips a gzipped body byte for byte", async () => {
    const store = new PostgresActivityCacheStore(db(), 1_000_000);
    const body = new Uint8Array([0x1f, 0x8b, 0, 255, 1, 2, 3]);
    await store.put("test:a", body);
    expect(await store.get("test:a")).toEqual(body);
    expect(await store.get("test:missing")).toBeNull();
  });

  test("a second put of the same key keeps the first body (immutable windows)", async () => {
    const store = new PostgresActivityCacheStore(db(), 1_000_000);
    await store.put("test:b", new Uint8Array([1]));
    await store.put("test:b", new Uint8Array([2]));
    expect(await store.get("test:b")).toEqual(new Uint8Array([1]));
  });

  test("stays within its byte budget, dropping the least recently hit first", async () => {
    await client()`DELETE FROM ais_activity_cache WHERE key LIKE 'test:%'`;
    // Budget of 250 bytes holds two 100-byte bodies, not three.
    const store = new PostgresActivityCacheStore(db(), 250);
    const body = new Uint8Array(100);
    await store.put("test:old", body);
    await store.put("test:mid", body);
    // a hit makes "old" the most recently used
    await store.get("test:old");
    await store.put("test:new", body);
    const rows = await client()<{ key: string }[]>`
      SELECT key FROM ais_activity_cache WHERE key LIKE 'test:%' ORDER BY key`;
    expect(rows.map((r) => r.key)).toEqual(["test:new", "test:old"]);
  });
});
