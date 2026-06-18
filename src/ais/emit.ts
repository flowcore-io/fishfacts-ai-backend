import type { AisPositionFixObserved } from "@/events/contracts";
import type { JobLatestItem } from "@/jobs/types";
import type { AisFix } from "./types";

/** Map a normalized fix to the source-agnostic event payload. */
export function toPayload(
  fix: AisFix,
  observedAt: string,
): AisPositionFixObserved {
  return {
    sourceId: fix.sourceId,
    vesselId: fix.vesselId,
    vesselSourceId: fix.vesselSourceId,
    latitude: fix.latitude,
    longitude: fix.longitude,
    speed: fix.speed,
    heading: fix.heading,
    course: fix.course,
    status: fix.status,
    eventTime: fix.eventTime,
    ingestTime: fix.ingestTime,
    observedAt,
    source: "mysql-replica",
  };
}

export function toLatestItem(fix: AisFix): JobLatestItem {
  return {
    signature: String(fix.sourceId),
    title: `vessel ${fix.vesselId} @ ${fix.eventTime}`,
    url: `ais://location/${fix.sourceId}`,
    status: "current",
    createdAt: fix.eventTime,
    lastCheckedAt: fix.ingestTime,
  };
}

/**
 * Run `fn` over items with bounded concurrency. Used by the TAIL job (live fixes
 * are never revisited, so out-of-order emission is fine). The BACKFILL job emits
 * sequentially within a bucket on purpose (one linear stream per bucket).
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** Reject if `promise` doesn't settle within `ms` (the SDK webhook has no timeout). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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
 * surfaces instead of spinning forever; the caller then resumes from its state.
 * Shared by the backfill and tail emit paths (`label` tags the log line).
 */
export async function emitBatchWithRetry(
  fn: () => Promise<string[]>,
  stopped: () => boolean,
  timeoutMs: number,
  label = "ais",
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
        `[${label}] batch emit failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
