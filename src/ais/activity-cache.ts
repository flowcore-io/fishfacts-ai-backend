/**
 * Response cache for the activity endpoints.
 *
 * Two tiers, both holding the gzipped body:
 *
 * - a per-pod LRU, **bounded by bytes** — the leader OOM'd in October on an
 *   unbounded in-process store, so nothing here grows without a ceiling;
 * - a Postgres table (`ais_activity_cache`) for IMMUTABLE windows only — those
 *   that ended over a day ago. The backend runs more than one replica, so a
 *   per-pod cache alone would mean a pre-warm only warms one pod. Postgres is
 *   the store every replica already shares. Also bounded by total bytes.
 *
 * Concurrent requests for the same key share one build, so a pre-warm loop and
 * a user opening the same season do not each pay ClickHouse for it.
 */
import type { Database } from "@/db/client";
import { aisActivityCache } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export interface ActivityCacheStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, gz: Uint8Array): Promise<void>;
}

type LruEntry = { gz: Uint8Array; expiresAt: number };

/** Map-backed LRU whose capacity is a byte budget, not an entry count. */
export class ByteBoundedLru {
  private readonly entries = new Map<string, LruEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string, nowMs: number): Uint8Array | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.delete(key);
      return null;
    }
    // Re-insert = most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.gz;
  }

  set(key: string, gz: Uint8Array, expiresAt: number): void {
    this.delete(key);
    // One body bigger than a quarter of the budget would evict most of what is
    // there for itself; it is served from Postgres (or rebuilt) instead.
    if (gz.byteLength > this.maxBytes / 4) return;
    this.entries.set(key, { gz, expiresAt });
    this.bytes += gz.byteLength;
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= entry.gz.byteLength;
    }
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.gz.byteLength;
  }
}

/** Shared tier: gzipped bodies of immutable windows in Postgres. */
export class PostgresActivityCacheStore implements ActivityCacheStore {
  constructor(
    private readonly db: Database,
    private readonly maxBytes: number,
  ) {}

  async get(key: string): Promise<Uint8Array | null> {
    const rows = await this.db
      .update(aisActivityCache)
      .set({ lastHitAt: sql`now()` })
      .where(eq(aisActivityCache.key, key))
      .returning({ bodyGz: aisActivityCache.bodyGz });
    const body = rows[0]?.bodyGz;
    return body ? new Uint8Array(body) : null;
  }

  async put(key: string, gz: Uint8Array): Promise<void> {
    await this.db
      .insert(aisActivityCache)
      .values({ key, bodyGz: Buffer.from(gz), bytes: gz.byteLength })
      .onConflictDoNothing();
    // Keep the most recently hit entries that fit in the budget; drop the rest.
    await this.db.execute(sql`
      DELETE FROM ais_activity_cache WHERE key IN (
        SELECT key FROM (
          SELECT key, sum(bytes) OVER (ORDER BY last_hit_at DESC, key) AS running
          FROM ais_activity_cache
        ) ranked
        WHERE running > ${this.maxBytes}
      )`);
  }
}

export type CacheSource = "memory" | "store" | "built" | "coalesced";

export type BuiltBodies = {
  /** The body for the request that built it (`meta.cached: false`). */
  fresh: Uint8Array;
  /** The body every later reader gets (`meta.cached: true`). */
  stored: Uint8Array;
};

export class ActivityResponseCache {
  private readonly memory: ByteBoundedLru;
  private readonly inflight = new Map<string, Promise<Uint8Array>>();

  constructor(
    private readonly opts: {
      store: ActivityCacheStore | null;
      memoryMaxBytes: number;
      /** How long a still-changing (recent) window is reused. */
      mutableTtlMs: number;
      now?: () => number;
    },
  ) {
    this.memory = new ByteBoundedLru(opts.memoryMaxBytes);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async get(
    key: string,
    immutable: boolean,
    build: () => Promise<BuiltBodies>,
  ): Promise<{ gz: Uint8Array; source: CacheSource }> {
    const expiresAt = immutable
      ? Number.POSITIVE_INFINITY
      : this.now() + this.opts.mutableTtlMs;

    const hit = this.memory.get(key, this.now());
    if (hit) return { gz: hit, source: "memory" };

    const pending = this.inflight.get(key);
    if (pending) return { gz: await pending, source: "coalesced" };

    // Registered before the first await, so a request arriving while the store
    // is being read joins this one instead of starting a second build.
    const work = this.load(key, immutable, expiresAt, build);
    const stored = work.then((r) => r.stored);
    // Waiters see the error through `stored`; keep it from also surfacing as
    // an unhandled rejection when nobody is waiting.
    stored.catch(() => {});
    this.inflight.set(key, stored);
    try {
      const result = await work;
      return result.fresh
        ? { gz: result.fresh, source: "built" }
        : { gz: result.stored, source: "store" };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async load(
    key: string,
    immutable: boolean,
    expiresAt: number,
    build: () => Promise<BuiltBodies>,
  ): Promise<{ stored: Uint8Array; fresh?: Uint8Array }> {
    if (immutable && this.opts.store) {
      const stored = await this.opts.store.get(key).catch((error) => {
        // A store outage costs a rebuild, never an error page.
        console.error("[AIS] activity cache read failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (stored) {
        this.memory.set(key, stored, expiresAt);
        return { stored };
      }
    }
    const bodies = await build();
    this.memory.set(key, bodies.stored, expiresAt);
    if (immutable && this.opts.store) {
      await this.opts.store.put(key, bodies.stored).catch((error) => {
        console.error("[AIS] activity cache write failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { stored: bodies.stored, fresh: bodies.fresh };
  }
}
