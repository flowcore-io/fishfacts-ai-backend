import type { Sql } from "postgres";

type ReservedConnection = Awaited<ReturnType<Sql["reserve"]>>;

/**
 * "Only one pod does this", via a Postgres advisory lock.
 *
 * The lock lives on a reserved (pinned) connection held for as long as this pod
 * is the leader. On pod death the connection drops and Postgres releases the
 * lock automatically, so another pod takes over on its next check — there is no
 * lease to expire and nothing to clean up after a crash.
 *
 * Extracted from AisBackfillSupervisor, which needed exactly this and had its
 * own copy: under replicas > 1 every pod ran the supervised jobs, so runs
 * clobbered each other. The job scheduler has the same problem for the same
 * reason, and two mechanisms for one question is one too many.
 *
 * Callers get a *best-effort* answer: any error resolves to "not leader", on the
 * principle that declining to act is safer than two pods acting at once.
 */
export class PostgresLeaderLock {
  private connection: ReservedConnection | null = null;

  /**
   * @param lockKey Must be unique per concern. Two callers sharing a key
   *   silently exclude each other.
   */
  constructor(
    private readonly sql: Sql,
    private readonly lockKey: number,
  ) {}

  /** True only on the single pod currently holding the lock. */
  async isLeader(): Promise<boolean> {
    if (this.connection) {
      try {
        await this.connection`select 1`;
        return true; // still holding a live locked connection
      } catch {
        // Connection died, so Postgres already released the lock. Drop our
        // handle and fall through to re-acquire.
        try {
          await this.connection.release();
        } catch {}
        this.connection = null;
      }
    }
    try {
      const connection = await this.sql.reserve();
      const rows =
        await connection`select pg_try_advisory_lock(${this.lockKey}) as locked`;
      if (rows[0]?.locked) {
        this.connection = connection;
        return true;
      }
      await connection.release();
      return false;
    } catch {
      return false;
    }
  }

  /** Give up leadership. Releasing the connection releases the lock. */
  release(): void {
    if (!this.connection) return;
    const connection = this.connection;
    this.connection = null;
    void connection.release();
  }
}
