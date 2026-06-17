import { sql } from "drizzle-orm";
/**
 * AIS backfill status / monitor. Reads progress from Postgres (ais_backfill_buckets).
 *   bun run ais:backfill:status            # one snapshot
 *   bun run ais:backfill:status --watch    # live, with rate + ETA (5s)
 */
import { createDb } from "../src/db/client";
import { loadEnv } from "../src/env";

const watch = process.argv.includes("--watch");
const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

type Snap = {
  complete: number;
  in_progress: number;
  pending: number;
  total: number;
  emitted: number;
  avgPerBucket: number;
  minH: string | null;
  maxH: string | null;
};

async function snapshot(): Promise<Snap> {
  const rows = await db.execute<{
    complete: string;
    in_progress: string;
    pending: string;
    total: string;
    emitted: string;
    avg_per_bucket: string | null;
    min_h: string | null;
    max_h: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'complete')     AS complete,
      count(*) FILTER (WHERE status = 'in_progress')  AS in_progress,
      count(*) FILTER (WHERE status = 'pending')      AS pending,
      count(*)                                        AS total,
      coalesce(sum(emitted_count), 0)                 AS emitted,
      round(avg(source_count) FILTER (WHERE status = 'complete'))::bigint AS avg_per_bucket,
      min(bucket_hour)::text                          AS min_h,
      max(bucket_hour)::text                          AS max_h
    FROM ais_backfill_buckets
  `);
  const r = (
    Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
  )[0] as {
    complete: string;
    in_progress: string;
    pending: string;
    total: string;
    emitted: string;
    avg_per_bucket: string | null;
    min_h: string | null;
    max_h: string | null;
  };
  return {
    complete: Number(r?.complete ?? 0),
    in_progress: Number(r?.in_progress ?? 0),
    pending: Number(r?.pending ?? 0),
    total: Number(r?.total ?? 0),
    emitted: Number(r?.emitted ?? 0),
    avgPerBucket: Number(r?.avg_per_bucket ?? 0),
    minH: r?.min_h ?? null,
    maxH: r?.max_h ?? null,
  };
}

function pct(a: number, b: number): string {
  return b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—";
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function render(s: Snap, rate?: number) {
  const remainingBuckets = s.pending + s.in_progress;
  const remainingEvents = remainingBuckets * s.avgPerBucket;
  console.log(
    [
      `AIS backfill  range ${s.minH ?? "—"} → ${s.maxH ?? "—"}`,
      `  buckets : ${s.complete}/${s.total} complete (${pct(s.complete, s.total)})  | in-progress ${s.in_progress}  pending ${s.pending}`,
      `  emitted : ${s.emitted.toLocaleString()} events`,
      rate !== undefined
        ? `  rate    : ${rate.toFixed(0)}/s  | ETA ~${fmtEta(rate > 0 ? remainingEvents / rate : Number.POSITIVE_INFINITY)} (≈${remainingEvents.toLocaleString()} events left @ ${s.avgPerBucket.toLocaleString()}/bucket)`
        : "  (run with --watch for rate + ETA)",
    ].join("\n"),
  );
}

try {
  if (!watch) {
    render(await snapshot());
  } else {
    let prev = await snapshot();
    render(prev);
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const cur = await snapshot();
      const rate = (cur.emitted - prev.emitted) / 5;
      console.log("—".repeat(40));
      render(cur, rate);
      prev = cur;
    }
  }
} finally {
  await client.end().catch(() => {});
}
if (!watch) process.exit(0);
