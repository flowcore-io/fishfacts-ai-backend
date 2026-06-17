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
