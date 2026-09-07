import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { PostgresLeaderLock } from "../../src/db/leader-lock";

const LOCK_KEY = 4144008;

type FakeOptions = {
  /** What `pg_try_advisory_lock` answers on each acquire, in order. */
  locks: boolean[];
  reserveThrows?: boolean;
};

/**
 * Minimal stand-in for postgres.js: a reserved connection is itself a tagged
 * template function, and carries `release()`.
 */
function fakeSql(options: FakeOptions) {
  const state = { reserves: 0, releases: 0, connectionAlive: true };
  const sql = {
    reserve: async () => {
      if (options.reserveThrows) throw new Error("pool exhausted");
      const acquired = options.locks[state.reserves] ?? false;
      state.reserves += 1;
      const connection = (async () => {
        // Any query on a dropped connection fails — that is how the holder
        // learns the lock is gone.
        if (!state.connectionAlive) throw new Error("connection closed");
        return [{ locked: acquired }];
      }) as unknown as Awaited<ReturnType<Sql["reserve"]>>;
      (connection as unknown as { release: () => Promise<void> }).release =
        async () => {
          state.releases += 1;
        };
      return connection;
    },
  } as unknown as Sql;
  return { sql, state };
}

describe("PostgresLeaderLock", () => {
  test("acquiring the advisory lock makes this pod the leader", async () => {
    const { sql } = fakeSql({ locks: [true] });
    const lock = new PostgresLeaderLock(sql, LOCK_KEY);

    expect(await lock.isLeader()).toBe(true);
  });

  test("a pod that loses the race is not leader and does not leak the connection", async () => {
    const { sql, state } = fakeSql({ locks: [false] });
    const lock = new PostgresLeaderLock(sql, LOCK_KEY);

    expect(await lock.isLeader()).toBe(false);
    // The reserved connection must go back to the pool, or repeated checks
    // would drain it — the pool is only 10 wide.
    expect(state.releases).toBe(1);
  });

  test("the leader reuses its pinned connection instead of re-acquiring", async () => {
    const { sql, state } = fakeSql({ locks: [true] });
    const lock = new PostgresLeaderLock(sql, LOCK_KEY);

    expect(await lock.isLeader()).toBe(true);
    expect(await lock.isLeader()).toBe(true);
    expect(await lock.isLeader()).toBe(true);

    expect(state.reserves).toBe(1);
  });

  test("a dropped connection means leadership is lost and re-contested", async () => {
    // This is the whole failover story: on pod death Postgres releases the
    // advisory lock by itself, so there is no lease to expire.
    const { sql, state } = fakeSql({ locks: [true, true] });
    const lock = new PostgresLeaderLock(sql, LOCK_KEY);

    expect(await lock.isLeader()).toBe(true);
    state.connectionAlive = false;

    // Re-acquires rather than reporting a stale true.
    expect(await lock.isLeader()).toBe(false);
    expect(state.reserves).toBe(2);
  });

  test("an unreachable database reports follower rather than throwing", async () => {
    // Declining to act is safer than two pods acting at once.
    const { sql } = fakeSql({ locks: [], reserveThrows: true });
    const lock = new PostgresLeaderLock(sql, LOCK_KEY);

    expect(await lock.isLeader()).toBe(false);
  });

  test("release() gives up leadership", async () => {
    const { sql, state } = fakeSql({ locks: [true, true] });
    const lock = new PostgresLeaderLock(sql, LOCK_KEY);

    expect(await lock.isLeader()).toBe(true);
    lock.release();

    expect(state.releases).toBe(1);
    // Next check has to contest the lock again rather than assume it still holds.
    expect(await lock.isLeader()).toBe(true);
    expect(state.reserves).toBe(2);
  });
});
