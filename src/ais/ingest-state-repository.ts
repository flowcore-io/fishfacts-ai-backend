import type { Database } from "@/db/client";
import { aisBackfillBuckets, aisIngestState } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import type { AisTailCursor } from "./types";

export type BackfillBucket = {
  bucketHour: string;
  status: string;
  lastTs: string | null;
  lastId: number | null;
  sourceCount: number | null;
  emittedCount: number;
};

/**
 * AIS pipeline control (the "config" row). `startAt` = cutover boundary T0 (tail
 * covers [T0, ∞); backfill covers [backfillStartAt, T0)). `backfillEnabled` is
 * the durable pause/resume switch the supervisor honors.
 */
export type AisControl = {
  startAt: string | null;
  backfillStartAt: string | null;
  backfillEnabled: boolean;
};

/**
 * Operational AIS ingestion state in Postgres. NOT a projector — this is
 * producer-side control/progress (start point, tail cursor, per-bucket backfill
 * progress). The ClickHouse read model is the projection target.
 */
export class AisIngestStateRepository {
  constructor(private readonly db: Database) {}

  /** Overridable start point (config row). null ⇒ caller treats as "now". */
  async getConfigStartAt(): Promise<string | null> {
    const rows = await this.db
      .select({ startAt: aisIngestState.startAt })
      .from(aisIngestState)
      .where(eq(aisIngestState.id, "config"))
      .limit(1);
    const v = rows[0]?.startAt;
    return v ? new Date(v).toISOString() : null;
  }

  /** Full pipeline control (config row). Defaults when the row is absent. */
  async getControl(): Promise<AisControl> {
    const rows = await this.db
      .select({
        startAt: aisIngestState.startAt,
        backfillStartAt: aisIngestState.backfillStartAt,
        backfillEnabled: aisIngestState.backfillEnabled,
      })
      .from(aisIngestState)
      .where(eq(aisIngestState.id, "config"))
      .limit(1);
    const r = rows[0];
    return {
      startAt: r?.startAt ? new Date(r.startAt).toISOString() : null,
      backfillStartAt: r?.backfillStartAt
        ? new Date(r.backfillStartAt).toISOString()
        : null,
      backfillEnabled: r?.backfillEnabled ?? false,
    };
  }

  /** Upsert one or more control fields on the config row. */
  async setControl(update: Partial<AisControl>): Promise<void> {
    const now = new Date();
    const set: Record<string, unknown> = { updatedAt: now };
    if ("startAt" in update)
      set.startAt = update.startAt ? new Date(update.startAt) : null;
    if ("backfillStartAt" in update)
      set.backfillStartAt = update.backfillStartAt
        ? new Date(update.backfillStartAt)
        : null;
    if ("backfillEnabled" in update)
      set.backfillEnabled = update.backfillEnabled;
    await this.db
      .insert(aisIngestState)
      .values({
        id: "config",
        startAt: update.startAt ? new Date(update.startAt) : null,
        backfillStartAt: update.backfillStartAt
          ? new Date(update.backfillStartAt)
          : null,
        backfillEnabled: update.backfillEnabled ?? false,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: aisIngestState.id, set });
  }

  async getTailCursor(): Promise<AisTailCursor | null> {
    const rows = await this.db
      .select({ cursor: aisIngestState.cursor })
      .from(aisIngestState)
      .where(eq(aisIngestState.id, "tail"))
      .limit(1);
    const c = rows[0]?.cursor as AisTailCursor | null | undefined;
    if (!c || typeof c.stampCreated !== "string") return null;
    return { stampCreated: c.stampCreated, lastId: Number(c.lastId ?? 0) };
  }

  async setTailCursor(
    cursor: AisTailCursor,
    emittedDelta: number,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(aisIngestState)
      .values({
        id: "tail",
        cursor,
        emittedCount: emittedDelta,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: aisIngestState.id,
        set: {
          cursor,
          emittedCount: sql`${aisIngestState.emittedCount} + ${emittedDelta}`,
          updatedAt: now,
        },
      });
  }

  // --- backfill buckets ---

  /** Insert pending rows for each hour-bucket; ignores buckets already present. */
  async upsertPendingBuckets(bucketHours: string[]): Promise<void> {
    if (bucketHours.length === 0) return;
    const CHUNK = 1000;
    for (let i = 0; i < bucketHours.length; i += CHUNK) {
      const slice = bucketHours.slice(i, i + CHUNK);
      await this.db
        .insert(aisBackfillBuckets)
        .values(slice.map((h) => ({ bucketHour: new Date(h) })))
        .onConflictDoNothing({ target: aisBackfillBuckets.bucketHour });
    }
  }

  /** Re-arm buckets left in_progress by a crashed/stopped prior run. */
  async resetInProgressToPending(): Promise<void> {
    await this.db
      .update(aisBackfillBuckets)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(aisBackfillBuckets.status, "in_progress"));
  }

  /**
   * Atomically claim the next pending bucket (lowest hour) and mark it
   * in_progress. `FOR UPDATE SKIP LOCKED` lets parallel workers (even across
   * instances) claim distinct buckets without contention. Returns null when
   * none remain.
   */
  async claimNextBucket(
    order: "asc" | "desc" = "asc",
  ): Promise<BackfillBucket | null> {
    // `order` selects which end of the pending range to fill next (newest-first
    // when "desc"). Within a bucket the stream is always ascending — bucket-level
    // order doesn't affect per-bucket linearity. Validated literal, safe to inline.
    const dir = sql.raw(order === "desc" ? "DESC" : "ASC");
    const result = await this.db.execute<{
      bucket_hour: Date | string;
      status: string;
      last_ts: Date | string | null;
      last_id: string | number | null;
      source_count: string | number | null;
      emitted_count: string | number;
    }>(sql`
      UPDATE ais_backfill_buckets
      SET status = 'in_progress', updated_at = now()
      WHERE bucket_hour = (
        SELECT bucket_hour FROM ais_backfill_buckets
        WHERE status = 'pending'
        ORDER BY bucket_hour ${dir}
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING bucket_hour, status, last_ts, last_id, source_count, emitted_count
    `);
    const rows = (
      Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{
      bucket_hour: Date | string;
      status: string;
      last_ts: Date | string | null;
      last_id: string | number | null;
      source_count: string | number | null;
      emitted_count: string | number;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      bucketHour: new Date(row.bucket_hour).toISOString(),
      status: row.status,
      lastTs: row.last_ts ? new Date(row.last_ts).toISOString() : null,
      lastId: row.last_id === null ? null : Number(row.last_id),
      sourceCount: row.source_count === null ? null : Number(row.source_count),
      emittedCount: Number(row.emitted_count),
    };
  }

  async setBucketProgress(
    bucketHour: string,
    update: { lastTs: string; lastId: number; emittedCount: number },
  ): Promise<void> {
    await this.db
      .update(aisBackfillBuckets)
      .set({
        lastTs: new Date(update.lastTs),
        lastId: update.lastId,
        emittedCount: update.emittedCount,
        updatedAt: new Date(),
      })
      .where(eq(aisBackfillBuckets.bucketHour, new Date(bucketHour)));
  }

  async markBucketComplete(
    bucketHour: string,
    update: { sourceCount: number; emittedCount: number },
  ): Promise<void> {
    await this.db
      .update(aisBackfillBuckets)
      .set({
        status: "complete",
        sourceCount: update.sourceCount,
        emittedCount: update.emittedCount,
        updatedAt: new Date(),
      })
      .where(eq(aisBackfillBuckets.bucketHour, new Date(bucketHour)));
  }

  async countByStatus(): Promise<{
    pending: number;
    complete: number;
    total: number;
  }> {
    const rows = await this.db
      .select({
        status: aisBackfillBuckets.status,
        count: sql<number>`count(*)::int`,
      })
      .from(aisBackfillBuckets)
      .groupBy(aisBackfillBuckets.status);
    let pending = 0;
    let complete = 0;
    let total = 0;
    for (const r of rows) {
      total += r.count;
      if (r.status === "pending") pending = r.count;
      if (r.status === "complete") complete = r.count;
    }
    return { pending, complete, total };
  }
}
