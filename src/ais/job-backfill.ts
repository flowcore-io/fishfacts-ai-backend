import type { Env } from "@/env";
import type { JobExecutionResult, JobLatestItem, JobState } from "@/jobs/types";
import type { PathwayWriter } from "@/pathways";
import type { AisClickhouseRepository } from "./clickhouse-repository";
import { toLatestItem, toPayload } from "./emit";
import type { FlowcoreBucketReader } from "./flowcore-bucket-reader";
import type { AisIngestStateRepository } from "./ingest-state-repository";
import type { AisSource } from "./types";

const HOUR_MS = 3_600_000;
const MAX_BUCKETS = 200_000; // ~22 years of hours — runaway guard

type Args = {
  startAt?: string;
  endAt?: string;
  bucketConcurrency: number;
  pageSize: number;
  batchSize: number;
  force: boolean;
  order?: "asc" | "desc";
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/**
 * Backfill: emit every historical fix through Flowcore, bucketed by hour.
 * Each hour-bucket is filled by ONE linear ascending stream to completion
 * (plan constraint #1 — prevents the consumer cursor from skipping within a
 * bucket); buckets are parallelized across workers. eventTime override =
 * location.timestamp ⇒ correct historical bucket + stable TimeUUID (idempotent
 * re-run). A per-bucket source-vs-ClickHouse count skip-check makes re-runs
 * cheap (data is fully additive).
 */
export function createAisBackfillJob(
  env: Env,
  writer: PathwayWriter,
  source: AisSource,
  state: AisIngestStateRepository,
  chRepo: AisClickhouseRepository,
  // When provided, each bucket is read back from Flowcore and projected to
  // ClickHouse after emit (the live pump can't replay buckets behind its
  // cursor). Omitted by the standalone emit-only runner (scripts/ais-backfill.ts).
  reader?: FlowcoreBucketReader,
) {
  return async function runAisBackfillJob(
    _previous: JobState | undefined,
    args: Args,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const endAt = args.endAt ?? new Date().toISOString();
    const startAt =
      args.startAt ??
      (await state.getConfigStartAt()) ??
      (await source.minEventTime()) ??
      endAt;

    const buckets = enumerateHourBuckets(startAt, endAt);
    await state.upsertPendingBuckets(buckets);
    await state.resetInProgressToPending();

    const concurrency =
      args.bucketConcurrency || env.AIS_BACKFILL_BUCKET_CONCURRENCY;
    const batchSize = args.batchSize || env.AIS_BACKFILL_BATCH_SIZE;
    const order = args.order ?? "asc";
    const latestItems: JobLatestItem[] = [];
    let emittedTotal = 0;
    let bucketsDone = 0;

    const stopped = () => context.signal.aborted || context.isStopRequested();

    const worker = async (): Promise<void> => {
      while (!stopped()) {
        const bucket = await state.claimNextBucket(order);
        if (!bucket) break;

        const sourceCount = await source.countBucket(bucket.bucketHour);
        if (sourceCount === 0) {
          await state.markBucketComplete(bucket.bucketHour, {
            sourceCount: 0,
            emittedCount: 0,
          });
          bucketsDone += 1;
          continue;
        }

        // Additive skip-check: already fully projected to ClickHouse?
        if (!args.force) {
          const chCount = await chRepo.countBucket(bucket.bucketHour);
          if (chCount >= sourceCount) {
            await state.markBucketComplete(bucket.bucketHour, {
              sourceCount,
              emittedCount: bucket.emittedCount,
            });
            bucketsDone += 1;
            continue;
          }
        }

        // One linear ascending stream for this bucket, to completion.
        let after =
          bucket.lastTs && bucket.lastId != null
            ? { ts: bucket.lastTs, id: bucket.lastId }
            : null;
        let bucketEmitted = bucket.emittedCount;
        while (!stopped()) {
          const fixes = await source.streamBucket(
            bucket.bucketHour,
            after,
            args.pageSize,
          );
          if (fixes.length === 0) break;
          const observedAt = new Date().toISOString();
          // Emit in ascending batches (one HTTP request per batch). Sequential
          // within the bucket keeps the stream linear; per-payload eventTime
          // override places each event in its historical bucket + TimeUUID.
          for (let i = 0; i < fixes.length; i += batchSize) {
            if (stopped()) return;
            const slice = fixes.slice(i, i + batchSize);
            // Retry transient webhook failures (403/5xx/network blips). Re-emit
            // is idempotent (same eventTime ⇒ same TimeUUID), so retrying a batch
            // never duplicates. A single blip must not kill a multi-day run.
            const ids = await emitBatchWithRetry(
              () =>
                writer.writeAisPositionFixBatch(
                  slice.map((f) => toPayload(f, observedAt)),
                ),
              stopped,
              env.AIS_EMIT_TIMEOUT_MS,
            );
            bucketEmitted += ids.length;
            emittedTotal += ids.length;
            const last = slice[slice.length - 1];
            after = { ts: last.eventTime, id: last.sourceId };
            await state.setBucketProgress(bucket.bucketHour, {
              lastTs: last.eventTime,
              lastId: last.sourceId,
              emittedCount: bucketEmitted,
            });
            if (latestItems.length < 25) latestItems.push(toLatestItem(last));
          }
          context.reportProgress({
            phase: "backfilling",
            message: `bucket ${bucket.bucketHour}: emitted ${bucketEmitted}/${sourceCount}`,
            detailsProcessed: emittedTotal,
          });
          if (fixes.length < args.pageSize) break;
        }

        if (stopped()) return;

        // Self-project: read the bucket back from Flowcore → ClickHouse. The live
        // pump only advances forward, so it never replays this historical bucket;
        // reading back from Flowcore (not MySQL) keeps the write path
        // Flowcore-sourced (CQRS) and reconciles against the source count,
        // catching webhook silent-drops under load. CH dedups via
        // ReplacingMergeTree, so re-projecting on retry is safe. On a shortfall
        // (e.g. Flowcore read lag), leave the bucket non-complete: the next
        // supervisor run re-arms it (resetInProgressToPending) and the skip-check
        // re-projects only the gap.
        if (reader) {
          let projected = 0;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (stopped()) return;
            projected = 0;
            await reader.fetchBucket(
              bucket.bucketHour,
              args.pageSize,
              async (payloads) => {
                for (const p of payloads) await chRepo.enqueue(p);
                projected += payloads.length;
              },
              stopped,
            );
            await chRepo.flush();
            if (projected >= sourceCount || stopped()) break;
            await new Promise((r) => setTimeout(r, 2000)); // Flowcore read lag
          }
          if (stopped()) return;
          if (projected < sourceCount) {
            context.reportProgress({
              phase: "backfilling",
              message: `bucket ${bucket.bucketHour}: projected ${projected}/${sourceCount} — deferring (retry next run)`,
              detailsProcessed: emittedTotal,
            });
            continue; // leave in_progress; re-armed + re-projected next run
          }
        }

        await state.markBucketComplete(bucket.bucketHour, {
          sourceCount,
          emittedCount: bucketEmitted,
        });
        bucketsDone += 1;
        context.reportProgress({
          phase: "backfilling",
          message: `completed ${bucketsDone}/${buckets.length} buckets`,
          detailsProcessed: emittedTotal,
          detailsTotal: buckets.length,
        });
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return {
      checkedAt,
      changed: emittedTotal > 0,
      latestItems: latestItems.slice(-25),
      message: `AIS backfill: ${bucketsDone} buckets, ${emittedTotal} fixes emitted (${startAt} → ${endAt})`,
    };
  };
}

/** Reject if a promise doesn't settle within ms (the hung fetch is abandoned). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emit timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Emit a batch, retrying transient failures with exponential backoff (1s→30s).
 * Gives up after maxAttempts so a truly persistent failure (e.g. revoked key)
 * surfaces instead of spinning forever; the runner then resumes from bucket state.
 */
async function emitBatchWithRetry(
  fn: () => Promise<string[]>,
  stopped: () => boolean,
  timeoutMs: number,
  maxAttempts = 10,
): Promise<string[]> {
  let attempt = 0;
  for (;;) {
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (err) {
      attempt += 1;
      if (stopped() || attempt >= maxAttempts) throw err;
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      console.error(
        `[ais-backfill] batch emit failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function enumerateHourBuckets(startAtIso: string, endAtIso: string): string[] {
  const start = floorToHour(startAtIso);
  const end = new Date(endAtIso).getTime();
  const buckets: string[] = [];
  for (let t = start; t < end && buckets.length < MAX_BUCKETS; t += HOUR_MS) {
    buckets.push(new Date(t).toISOString());
  }
  return buckets;
}

function floorToHour(iso: string): number {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}
