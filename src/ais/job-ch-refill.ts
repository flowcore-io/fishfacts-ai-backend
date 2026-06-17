import type { Env } from "@/env";
import type { JobExecutionResult, JobState } from "@/jobs/types";
import type { AisClickhouseRepository } from "./clickhouse-repository";
import type { FlowcoreBucketReader } from "./flowcore-bucket-reader";
import type { AisIngestStateRepository } from "./ingest-state-repository";

type Args = {
  concurrency: number;
  pageSize: number;
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
 * CH-refill — PROJECT ONLY: consume buckets the backfill job has emitted to
 * Flowcore (status complete, projection_status pending) and project them into
 * ClickHouse by reading them back from Flowcore (fetch API, pump-cursor
 * independent — same read strategy as scripts/ais-stream.ts). Decoupled from the
 * emit job so the Flowcore reads + CH inserts never block the emit's webhook
 * calls on the shared runtime. Idempotent: ReplacingMergeTree dedups, and a
 * bucket is only marked projected once its fetched count covers the source count.
 */
export function createAisChRefillJob(
  env: Env,
  reader: FlowcoreBucketReader,
  chRepo: AisClickhouseRepository,
  state: AisIngestStateRepository,
) {
  return async function runAisChRefillJob(
    _previous: JobState | undefined,
    args: Args,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    await state.resetInProgressProjectionsToPending();

    const concurrency = args.concurrency || env.AIS_CH_REFILL_CONCURRENCY;
    const order = args.order ?? "desc";
    let projectedTotal = 0;
    let bucketsDone = 0;

    const stopped = () => context.signal.aborted || context.isStopRequested();

    const worker = async (): Promise<void> => {
      while (!stopped()) {
        const bucket = await state.claimNextProjectionBucket(order);
        if (!bucket) break;
        const expected = bucket.sourceCount ?? bucket.emittedCount;

        // Read the bucket back from Flowcore → ClickHouse. Retry transient
        // fetch/insert errors + Flowcore read-lag (fetched < expected) a few times.
        let projected = 0;
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (stopped()) return;
          projected = 0;
          try {
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
          } catch (err) {
            console.error(
              `[ais-ch-refill] bucket ${bucket.bucketHour} fetch/insert failed (attempt ${attempt}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (projected >= expected || stopped()) break;
          await new Promise((r) => setTimeout(r, 2000)); // Flowcore read lag
        }

        if (stopped()) return;
        if (projected >= expected) {
          await state.markProjectionComplete(bucket.bucketHour, projected);
          projectedTotal += projected;
          bucketsDone += 1;
          context.reportProgress({
            phase: "projecting",
            message: `projected ${bucketsDone} buckets (${bucket.bucketHour}: ${projected})`,
            detailsProcessed: projectedTotal,
          });
        } else {
          // Short read after retries → re-arm for the next run.
          await state.resetProjectionToPending(bucket.bucketHour);
          context.reportProgress({
            phase: "projecting",
            message: `bucket ${bucket.bucketHour}: projected ${projected}/${expected} — deferring`,
            detailsProcessed: projectedTotal,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return {
      checkedAt,
      changed: projectedTotal > 0,
      latestItems: [],
      message: `AIS CH refill: ${bucketsDone} buckets, ${projectedTotal} rows projected`,
    };
  };
}
