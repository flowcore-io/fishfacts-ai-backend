/**
 * Parallel AIS → ClickHouse streamer. Bypasses the single-stream data-pump:
 * lists Flowcore time-buckets for fishfacts-ais.0, then processes N buckets
 * concurrently — paginating each (pageSize 5000) and inserting pages into
 * ClickHouse in parallel. Idempotent (ReplacingMergeTree dedups by source_id),
 * so re-running is safe. NOTE: this reads straight from the Flowcore fetch API,
 * independent of the pump cursor.
 *
 *   bun run ais:stream [concurrency=16] [pageSize=10000] [order=desc] [fromBucket] [toBucket]
 *
 * order: "desc" = newest buckets first (default), "asc" = oldest first.
 * Writes a resumable cursor to scripts/.ais-stream-cursor on every heartbeat:
 * the contiguous completed watermark from the processing-start end. For desc,
 * every bucket >= cursor is fully streamed → resume older data with
 * `ais:stream <c> <p> desc "" <cursor>`.
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import {
  EventsFetchCommand,
  EventsFetchTimeBucketsByNamesCommand,
  FlowcoreClient,
} from "@flowcore/sdk";
import { runClickhouseMigrations } from "../src/ais/clickhouse-migrate";
import { loadEnv } from "../src/env";
import {
  AIS_FLOW_TYPE,
  AIS_POSITION_FIX_OBSERVED_EVENT_TYPE,
  type AisPositionFixObserved,
} from "../src/events/contracts";

const CURSOR_FILE =
  process.env.AIS_STREAM_CURSOR_FILE ?? `${import.meta.dir}/.ais-stream-cursor`;
const CONCURRENCY = Number(process.argv[2] ?? 16);
const PAGE_SIZE = Number(process.argv[3] ?? 10000);
const ORDER =
  (process.argv[4] ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";
const FROM_BUCKET = process.argv[5] || undefined; // optional YYYYMMDDhh0000
const TO_BUCKET = process.argv[6] || undefined;

const env = loadEnv();
if (!env.FLOWCORE_DATA_CORE_ID) {
  console.error("FLOWCORE_DATA_CORE_ID is required");
  process.exit(1);
}
const TENANT = env.FLOWCORE_TENANT;
const DATA_CORE_ID = env.FLOWCORE_DATA_CORE_ID;
const FLOW = AIS_FLOW_TYPE;
const EVENT_TYPES = [AIS_POSITION_FIX_OBSERVED_EVENT_TYPE];

await runClickhouseMigrations(env);
const fc = new FlowcoreClient({ apiKey: env.FLOWCORE_API_KEY });
const ch = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
  database: env.CLICKHOUSE_DATABASE,
  max_open_connections: CONCURRENCY + 4,
  keep_alive: { enabled: true, idle_socket_ttl: 2500 },
});

type ChRow = {
  source_id: number;
  vessel_id: number;
  vessel_source_id: number | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  course: number | null;
  status: string | null;
  event_time: string;
  ingest_time: string;
  observed_at: string;
  source: string;
};

const isoToCh = (iso: string) =>
  new Date(iso).toISOString().replace("T", " ").replace("Z", "");

function toRow(p: AisPositionFixObserved): ChRow {
  return {
    source_id: p.sourceId,
    vessel_id: p.vesselId,
    vessel_source_id: p.vesselSourceId,
    latitude: p.latitude,
    longitude: p.longitude,
    speed: p.speed,
    heading: p.heading,
    course: p.course,
    status: p.status,
    event_time: isoToCh(p.eventTime),
    ingest_time: isoToCh(p.ingestTime),
    observed_at: isoToCh(p.observedAt),
    source: p.source ?? "mysql-replica",
  };
}

async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 12) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      console.error(
        `[stream] ${what} failed (attempt ${attempt}), retry in ${delay}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

let stop = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (!stop) {
      console.log("\n[stream] stop requested — finishing in-flight pages…");
      stop = true;
    }
  });
}

console.log(
  `[stream] tenant=${TENANT} dataCore=${DATA_CORE_ID} flow=${FLOW} concurrency=${CONCURRENCY} pageSize=${PAGE_SIZE}`,
);

// 1. List all time buckets (paginate the bucket list itself).
const buckets: string[] = [];
let bcursor: number | undefined;
do {
  const res = await withRetry(
    () =>
      fc.execute(
        new EventsFetchTimeBucketsByNamesCommand({
          tenant: TENANT,
          dataCoreId: DATA_CORE_ID,
          flowType: FLOW,
          eventTypes: EVENT_TYPES,
          pageSize: 10_000,
          cursor: bcursor,
          fromTimeBucket: FROM_BUCKET,
          toTimeBucket: TO_BUCKET,
        }),
      ),
    "list-buckets",
  );
  buckets.push(...res.timeBuckets);
  bcursor = res.nextCursor;
} while (bcursor !== undefined && !stop);

// Order buckets: time-bucket strings (YYYYMMDDhh0000) sort lexicographically.
buckets.sort();
if (ORDER === "desc") buckets.reverse();
console.log(
  `[stream] ${buckets.length} time-buckets to process (${ORDER}, ${buckets[0] ?? "—"} → ${buckets[buckets.length - 1] ?? "—"})`,
);

// 2. Process buckets concurrently; paginate each and insert pages into CH.
let nextIdx = 0;
let totalEvents = 0;
let bucketsDone = 0;
const startedAt = performance.now();

// Resumable cursor = contiguous completed watermark from the start of the
// processing order. With out-of-order parallel completion, this is the last
// bucket such that every bucket before it (in processing order) is done.
const completed = new Set<string>();
function computeCursor(): string | undefined {
  let cursor: string | undefined;
  for (const b of buckets) {
    if (!completed.has(b)) break;
    cursor = b;
  }
  return cursor;
}

const heartbeat = setInterval(() => {
  const s = (performance.now() - startedAt) / 1000;
  const cursor = computeCursor();
  if (cursor) writeFileSync(CURSOR_FILE, cursor);
  console.log(
    `[stream] buckets ${bucketsDone}/${buckets.length} · events=${totalEvents.toLocaleString()} · ${(totalEvents / s).toFixed(0)}/s · cursor=${cursor ?? "—"}`,
  );
}, 10_000);

const failedBuckets: string[] = [];

async function worker(): Promise<void> {
  while (!stop) {
    const bucket = buckets[nextIdx++];
    if (bucket === undefined) break;
    // A bucket that exhausts all retries is quarantined (not marked complete, so
    // it never advances the contiguous cursor) and the worker moves on — one bad
    // bucket must not crash a multi-hour run. Re-run later to retry quarantined
    // buckets (idempotent via ReplacingMergeTree).
    try {
      let pcursor: string | undefined;
      do {
        const res = await withRetry(
          () =>
            fc.execute(
              new EventsFetchCommand({
                tenant: TENANT,
                dataCoreId: DATA_CORE_ID,
                flowType: FLOW,
                eventTypes: EVENT_TYPES,
                timeBucket: bucket,
                pageSize: PAGE_SIZE,
                cursor: pcursor,
              }),
            ),
          `fetch ${bucket}`,
        );
        if (res.events.length > 0) {
          const rows = res.events.map((e) =>
            toRow(e.payload as unknown as AisPositionFixObserved),
          );
          await withRetry(
            () =>
              ch.insert({
                table: "ais_position_fixes",
                values: rows,
                format: "JSONEachRow",
              }),
            `insert ${bucket}`,
          );
          totalEvents += rows.length;
        }
        pcursor = res.nextCursor;
      } while (pcursor !== undefined && !stop);
      if (!stop) completed.add(bucket);
    } catch (err) {
      failedBuckets.push(bucket);
      console.error(
        `[stream] bucket ${bucket} QUARANTINED after retries, continuing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    bucketsDone += 1;
  }
}

try {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const s = (performance.now() - startedAt) / 1000;
  const cursor = computeCursor();
  if (cursor) writeFileSync(CURSOR_FILE, cursor);
  console.log(
    `[stream] ${stop ? "stopped" : "done"}: ${totalEvents.toLocaleString()} events, ${bucketsDone}/${buckets.length} buckets in ${(s / 60).toFixed(1)} min (${(totalEvents / s).toFixed(0)}/s)`,
  );
  console.log(
    `[stream] cursor=${cursor ?? "—"} (every ${ORDER === "desc" ? "newer" : "older"} bucket fully streamed; written to ${CURSOR_FILE})`,
  );
  if (failedBuckets.length > 0) {
    console.error(
      `[stream] ${failedBuckets.length} QUARANTINED bucket(s) — re-run to retry: ${failedBuckets.sort().join(", ")}`,
    );
  }
} finally {
  clearInterval(heartbeat);
  await ch.close().catch(() => {});
  fc.close();
}
process.exit(0);
