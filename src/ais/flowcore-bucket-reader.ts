import type { Env } from "@/env";
import {
  AIS_FLOW_TYPE,
  AIS_POSITION_FIX_OBSERVED_EVENT_TYPE,
  type AisPositionFixObserved,
} from "@/events/contracts";
import { EventsFetchCommand, FlowcoreClient } from "@flowcore/sdk";

// The Flowcore fetch cost grows SUPER-LINEARLY with pageSize on dense buckets: on
// a recent full-traffic AIS bucket, pageSize 1000 returns in ~2.5s, 2000 in ~7s,
// 5000 in ~13s, but 10000 never returns within 60s (measured against prod). Sparse
// historical buckets (2014) are the opposite — large pages are cheap. So no single
// fixed pageSize fits the whole 2014→now density range. We therefore (a) cap each
// page with a timeout, and (b) ADAPTIVELY SHRINK the page on timeout and retry the
// SAME cursor — each bucket auto-tunes to its own density. We never restart the
// whole bucket: a bucket can hold millions of events, and the caller persists the
// cursor per page so a deferred bucket resumes mid-pagination across runs.
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_MAX_ATTEMPTS = 12;
// Floor for the adaptive shrink — below this the fixed per-request overhead
// dominates and shrinking further buys nothing.
const MIN_PAGE_SIZE = 500;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
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
 * Reads AIS events back from Flowcore by hour-bucket via the fetch API
 * (`EventsFetchCommand`), independent of the data-pump cursor. The backfill job
 * uses this to project history into ClickHouse: the live pump cursor only moves
 * forward, so it never replays buckets the backfill emits *behind* it. Reading
 * back from Flowcore (not straight from MySQL) keeps the write path
 * Flowcore-sourced (CQRS) and doubles as count reconciliation against the
 * webhook (guards the silent-drop-under-load failure mode).
 */
export class FlowcoreBucketReader {
  // Lazily created on first fetch. The SDK validates the API key format in the
  // FlowcoreClient constructor, so building it at boot would crash the app on a
  // placeholder/test key — and the reader is only used during a real backfill.
  private fc: FlowcoreClient | null = null;

  constructor(private readonly env: Env) {}

  private client(): FlowcoreClient {
    if (!this.fc) {
      this.fc = new FlowcoreClient({ apiKey: this.env.FLOWCORE_API_KEY });
    }
    return this.fc;
  }

  /**
   * Paginate one hour-bucket from `startCursor`, invoking
   * `onPage(payloads, nextCursor)` per page so the caller can persist the cursor
   * after each page is durably handled (resume mid-bucket across runs). Each page
   * is fetched with a per-page timeout + retry on the SAME cursor (never restart
   * the bucket). `bucketHourIso` is converted to the `YYYYMMDDHH0000` bucket name.
   * Returns the number of events fetched this call. `stopped` aborts between pages.
   */
  async fetchBucket(
    bucketHourIso: string,
    pageSize: number,
    startCursor: string | undefined,
    onPage: (
      payloads: AisPositionFixObserved[],
      nextCursor: string | undefined,
    ) => Promise<void>,
    stopped?: () => boolean,
  ): Promise<number> {
    if (!this.env.FLOWCORE_DATA_CORE_ID) {
      throw new Error(
        "FLOWCORE_DATA_CORE_ID is required for backfill read-back",
      );
    }
    const timeBucket = isoToTimeBucket(bucketHourIso);
    let cursor = startCursor;
    let total = 0;
    // Per-bucket adaptive page size: shrinks on timeout (dense bucket) and stays
    // shrunk for the rest of this bucket, since density is ~uniform within an hour.
    const sizeBox = { size: pageSize };
    do {
      if (stopped?.()) break;
      const res = await this.fetchPage(timeBucket, sizeBox, cursor, stopped);
      if (res.events.length > 0) {
        await onPage(
          res.events.map((e) => e.payload as unknown as AisPositionFixObserved),
          res.nextCursor,
        );
        total += res.events.length;
      }
      cursor = res.nextCursor;
    } while (cursor !== undefined && !stopped?.());
    return total;
  }

  /**
   * Fetch one page, retrying the SAME cursor on timeout/error (exp backoff). On a
   * TIMEOUT (the dense-bucket super-linear cliff) it also HALVES `sizeBox.size`
   * (down to MIN_PAGE_SIZE) before retrying, so the bucket converges onto a page
   * size it can actually serve within the deadline instead of looping the timeout.
   */
  private async fetchPage(
    timeBucket: string,
    sizeBox: { size: number },
    cursor: string | undefined,
    stopped?: () => boolean,
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTimeout(
          this.client().execute(
            new EventsFetchCommand({
              tenant: this.env.FLOWCORE_TENANT,
              dataCoreId: this.env.FLOWCORE_DATA_CORE_ID as string,
              flowType: AIS_FLOW_TYPE,
              eventTypes: [AIS_POSITION_FIX_OBSERVED_EVENT_TYPE],
              timeBucket,
              pageSize: sizeBox.size,
              cursor,
            }),
          ),
          FETCH_TIMEOUT_MS,
          `flowcore fetch ${timeBucket}`,
        );
      } catch (err) {
        if (stopped?.() || attempt >= PAGE_MAX_ATTEMPTS) throw err;
        const timedOut =
          err instanceof Error && err.message.includes("timed out");
        if (timedOut && sizeBox.size > MIN_PAGE_SIZE) {
          sizeBox.size = Math.max(MIN_PAGE_SIZE, Math.floor(sizeBox.size / 2));
          console.error(
            `[ais-ch-refill] fetch ${timeBucket} timed out — shrinking pageSize to ${sizeBox.size}, retrying same cursor (attempt ${attempt}/${PAGE_MAX_ATTEMPTS})`,
          );
          continue; // retry immediately at the smaller size, same cursor
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        console.error(
          `[ais-ch-refill] fetch ${timeBucket} page failed (attempt ${attempt}/${PAGE_MAX_ATTEMPTS}), retry in ${delay}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  close(): void {
    this.fc?.close();
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
