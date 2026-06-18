import type { Env } from "@/env";
import type { JobExecutionResult, JobLatestItem, JobState } from "@/jobs/types";
import type { PathwayWriter } from "@/pathways";
import { emitBatchWithRetry, runPool, toLatestItem, toPayload } from "./emit";
import type { AisIngestStateRepository } from "./ingest-state-repository";
import type { AisSource, AisTailCursor } from "./types";

// Events per Flowcore webhook request (matches the backfill's proven batch size).
// The DB page (args.batchSize) is split into chunks of this for emission.
const EMIT_BATCH_SIZE = 500;

type Args = {
  batchSize: number;
  maxBatches: number;
  lookbackSeconds: number;
  emitConcurrency: number;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    detailsProcessed?: number;
  }) => void;
};

/**
 * Tail: emit newly-ingested fixes going forward. Cursor on `stamp_created`
 * (monotonic) with a small lookback overlap so late-committed rows aren't
 * missed (dupes are idempotent downstream). NO eventTime override → fresh
 * ingest-time TimeUUIDs.
 */
export function createAisTailJob(
  env: Env,
  writer: PathwayWriter,
  source: AisSource,
  state: AisIngestStateRepository,
) {
  return async function runAisTailJob(
    _previous: JobState | undefined,
    args: Args,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const configStart = await state.getConfigStartAt();
    const startAt = configStart ?? new Date().toISOString(); // empty ⇒ now
    const stored = await state.getTailCursor();

    // First page rewinds by the lookback window; later pages use exact keyset.
    let pageCursor: AisTailCursor = stored
      ? {
          stampCreated: rewind(stored.stampCreated, args.lookbackSeconds),
          lastId: 0,
        }
      : { stampCreated: startAt, lastId: 0 };

    const emitConcurrency =
      args.emitConcurrency || env.AIS_TAIL_EMIT_CONCURRENCY;
    const latestItems: JobLatestItem[] = [];
    let emittedTotal = 0;

    for (let batch = 0; batch < args.maxBatches; batch += 1) {
      if (context.signal.aborted || context.isStopRequested()) break;
      const fixes = await source.fetchFixesAfterIngest(
        pageCursor,
        args.batchSize,
      );
      if (fixes.length === 0) break;

      const observedAt = new Date().toISOString();
      // Emit in BATCHES (one webhook request per chunk). Webhook latency is
      // per-request, so this is the throughput lever: emitting one event per
      // request (the old path) capped the tail at ~tens/s and let it fall hours
      // behind. `useEventTime: false` keeps fresh ingest-time TimeUUIDs/buckets
      // (no eventTime override — live fixes intentionally bucket by ingest time).
      const payloads = fixes.map((fix) => toPayload(fix, observedAt));
      const chunks: (typeof payloads)[] = [];
      for (let i = 0; i < payloads.length; i += EMIT_BATCH_SIZE) {
        chunks.push(payloads.slice(i, i + EMIT_BATCH_SIZE));
      }
      await runPool(chunks, emitConcurrency, async (chunk) => {
        await emitBatchWithRetry(
          () => writer.writeAisPositionFixBatch(chunk, { useEventTime: false }),
          () => context.signal.aborted || context.isStopRequested(),
          env.AIS_EMIT_TIMEOUT_MS,
          "ais-tail",
        );
      });
      emittedTotal += fixes.length;

      const last = fixes[fixes.length - 1];
      pageCursor = { stampCreated: last.ingestTime, lastId: last.sourceId };
      await state.setTailCursor(pageCursor, fixes.length);

      for (const fix of fixes.slice(-5)) latestItems.push(toLatestItem(fix));
      context.reportProgress({
        phase: "emitting",
        message: `AIS tail emitted ${emittedTotal} fixes`,
        detailsProcessed: emittedTotal,
      });
      if (fixes.length < args.batchSize) break;
    }

    return {
      checkedAt,
      changed: emittedTotal > 0,
      latestItems: latestItems.slice(-25),
      message: `AIS tail emitted ${emittedTotal} fixes (from ${
        stored ? stored.stampCreated : startAt
      })`,
    };
  };
}

function rewind(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() - seconds * 1000).toISOString();
}
