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

        // Stream the bucket Flowcore → ClickHouse, RESUMING from the persisted
        // cursor (a bucket can hold millions of events). Each page: insert →
        // persist the cursor + count, so a deferred bucket continues mid-pagination
        // next run instead of restarting. The reader retries a stalled page on the
        // SAME cursor (never restarts the bucket). On a page that exhausts retries,
        // we leave the bucket in_progress (cursor saved) and move on — the next
        // run re-arms in_progress → pending and resumes from the cursor.
        let projected = bucket.projectedCount;
        try {
          await reader.fetchBucket(
            bucket.bucketHour,
            args.pageSize,
            bucket.projectedCursor ?? undefined,
            async (payloads, nextCursor) => {
              for (const p of payloads) await chRepo.enqueue(p);
              await chRepo.flush();
              projected += payloads.length;
              await state.setProjectionProgress(bucket.bucketHour, {
                cursor: nextCursor ?? null,
                projectedCount: projected,
              });
            },
            stopped,
          );
        } catch (err) {
          context.reportProgress({
            phase: "projecting",
            message: `bucket ${bucket.bucketHour}: deferred at ${projected} rows — ${
              err instanceof Error ? err.message : String(err)
            }`,
            detailsProcessed: projectedTotal,
          });
          continue; // leave in_progress (cursor saved); re-armed + resumed next run
        }

        if (stopped()) return; // stop mid-bucket — cursor persisted, resumes later
        await state.markProjectionComplete(bucket.bucketHour, projected);
        projectedTotal += projected;
        bucketsDone += 1;
        context.reportProgress({
          phase: "projecting",
          message: `projected ${bucketsDone} buckets (${bucket.bucketHour}: ${projected})`,
          detailsProcessed: projectedTotal,
        });
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
