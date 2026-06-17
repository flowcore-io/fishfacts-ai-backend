import type { Env } from "@/env";
import type { JobExecutionResult, JobLatestItem, JobState } from "@/jobs/types";
import type { PathwayWriter } from "@/pathways";
import { toLatestItem, toPayload } from "./emit";
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
 * Backfill — EMIT ONLY: stream every historical fix MySQL → Flowcore, bucketed
 * by hour. Each hour-bucket is filled by ONE linear ascending stream to
 * completion (plan constraint #1 — prevents the consumer cursor skipping within
 * a bucket); buckets are parallelized across workers. eventTime override =
 * location.timestamp ⇒ correct historical bucket + stable TimeUUID (idempotent
 * re-run). Projection into ClickHouse is a SEPARATE job (createAisChRefillJob)
 * that consumes emitted buckets — decoupled so the read-back/CH inserts never
 * block the emit on the shared runtime.
 */
export function createAisBackfillJob(
  env: Env,
  writer: PathwayWriter,
  source: AisSource,
  state: AisIngestStateRepository,
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
          // Nothing to emit ⇒ nothing to project either.
          await state.markBucketComplete(bucket.bucketHour, {
            sourceCount: 0,
            emittedCount: 0,
            projectionComplete: true,
          });
          bucketsDone += 1;
          continue;
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

        // Emit done ⇒ mark the bucket emitted (status complete). projection_status
        // stays 'pending' for the CH-refill job to pick up.
        await state.markBucketComplete(bucket.bucketHour, {
          sourceCount,
          emittedCount: bucketEmitted,
        });
        bucketsDone += 1;
        context.reportProgress({
          phase: "backfilling",
          message: `emitted ${bucketsDone}/${buckets.length} buckets`,
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
