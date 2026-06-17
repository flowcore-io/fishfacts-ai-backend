import type { Env } from "@/env";
import {
  AIS_FLOW_TYPE,
  AIS_POSITION_FIX_OBSERVED_EVENT_TYPE,
  type AisPositionFixObserved,
} from "@/events/contracts";
import { EventsFetchCommand, FlowcoreClient } from "@flowcore/sdk";

/**
 * Reads AIS events back from Flowcore by hour-bucket via the fetch API
 * (`EventsFetchCommand`), independent of the data-pump cursor. The backfill job
 * uses this to project history into ClickHouse: the live pump cursor only moves
 * forward, so it never replays buckets the backfill emits *behind* it. Reading
 * back from Flowcore (not straight from MySQL) keeps the write path
 * Flowcore-sourced (CQRS) and doubles as count reconciliation against the
 * webhook (guards the silent-drop-under-load failure mode).
 */
export class FlowcoreBucketReader {
  private readonly fc: FlowcoreClient;
  private readonly tenant: string;
  private readonly dataCoreId: string;

  constructor(env: Env) {
    if (!env.FLOWCORE_DATA_CORE_ID) {
      throw new Error(
        "FLOWCORE_DATA_CORE_ID is required for backfill read-back",
      );
    }
    this.fc = new FlowcoreClient({ apiKey: env.FLOWCORE_API_KEY });
    this.tenant = env.FLOWCORE_TENANT;
    this.dataCoreId = env.FLOWCORE_DATA_CORE_ID;
  }

  /**
   * Paginate one hour-bucket, invoking `onPage` with each page of payloads.
   * `bucketHourIso` is the hour-floored ISO timestamp (as enumerated by the
   * backfill); it is converted to the Flowcore `YYYYMMDDHH0000` time-bucket name.
   * Returns the total number of events fetched. `stopped` aborts between pages
   * (the caller keeps the bucket non-complete so it resumes later).
   */
  async fetchBucket(
    bucketHourIso: string,
    pageSize: number,
    onPage: (payloads: AisPositionFixObserved[]) => Promise<void>,
    stopped?: () => boolean,
  ): Promise<number> {
    const timeBucket = isoToTimeBucket(bucketHourIso);
    let cursor: string | undefined;
    let total = 0;
    do {
      if (stopped?.()) break;
      const res = await this.fc.execute(
        new EventsFetchCommand({
          tenant: this.tenant,
          dataCoreId: this.dataCoreId,
          flowType: AIS_FLOW_TYPE,
          eventTypes: [AIS_POSITION_FIX_OBSERVED_EVENT_TYPE],
          timeBucket,
          pageSize,
          cursor,
        }),
      );
      if (res.events.length > 0) {
        await onPage(
          res.events.map((e) => e.payload as unknown as AisPositionFixObserved),
        );
        total += res.events.length;
      }
      cursor = res.nextCursor;
    } while (cursor !== undefined && !stopped?.());
    return total;
  }

  close(): void {
    this.fc.close();
  }
}

/** Hour-floored ISO → Flowcore time-bucket name `YYYYMMDDHH0000` (UTC). */
export function isoToTimeBucket(iso: string): string {
  const d = new Date(iso);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}0000`
  );
}
