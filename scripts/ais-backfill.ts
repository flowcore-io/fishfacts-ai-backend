/**
 * AIS backfill runner — emits historical AIS fixes into Flowcore (one event per
 * fix, batched). Durable + resumable: progress lives in Postgres
 * (ais_backfill_buckets), so stop = Ctrl-C / kill, resume = re-run with the same
 * window. ClickHouse streaming is a separate phase (run the app's pump after).
 *
 *   bun run ais:backfill [daysBack=365]
 *   bun run ais:backfill 90
 *
 * Persistent run (survives terminal close):
 *   nohup bun run ais:backfill 365 > backfill.log 2>&1 &
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AisIngestStateRepository } from "../src/ais/ingest-state-repository";
import { createAisBackfillJob } from "../src/ais/job-backfill";
import { closeAisPool } from "../src/ais/mysql-pool";
import { createAisSource } from "../src/ais/source";
import { AreasProjector } from "../src/areas/projector";
import { AreasRepository } from "../src/areas/repository";
import { createDb } from "../src/db/client";
import { loadEnv } from "../src/env";
import { PostgresGenericEventRepository } from "../src/events/repository";
import { JMeldingGeoProjector } from "../src/jmelding/geo-projector";
import { JMeldingChunkAssembler } from "../src/jobs/jmelding-chunk-assembler";
import { JMeldingFragmentProjector } from "../src/jobs/jmelding-fragments";
import { createPathwayRuntime } from "../src/pathways";
import { SildelagetCatchProjector } from "../src/sildelaget/projector";
import { SildelagetCatchRepository } from "../src/sildelaget/repository";
import { UsableApiClient } from "../src/usable/client";

const daysBack = Number(process.argv[2] ?? 365);
const bucketConcurrency = Number(process.argv[3] ?? 0); // 0 ⇒ env default
const order = process.argv[4] === "desc" ? "desc" : "asc"; // bucket fill order
if (!Number.isFinite(daysBack) || daysBack <= 0) {
  console.error(
    "usage: bun run ais:backfill [daysBack>0] [bucketConcurrency] [asc|desc]",
  );
  process.exit(1);
}

// Single-instance guard — two concurrent backfills doubled host load and wedged
// the box. Refuse to start if another live runner holds the lock; a stale lock
// (PID dead, e.g. after SIGKILL) is overwritten.
const LOCK_FILE = "backfill.lock";
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
if (existsSync(LOCK_FILE)) {
  const existing = Number(readFileSync(LOCK_FILE, "utf8").trim());
  if (
    Number.isInteger(existing) &&
    existing !== process.pid &&
    pidAlive(existing)
  ) {
    console.error(
      `[backfill] another backfill is already running (pid ${existing}); refusing to start. Stop it first, or remove ${LOCK_FILE} if it's stale.`,
    );
    process.exit(1);
  }
}
writeFileSync(LOCK_FILE, String(process.pid));
function releaseLock() {
  try {
    if (
      existsSync(LOCK_FILE) &&
      readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)
    ) {
      rmSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
const usable = new UsableApiClient(env);

// Emit-only: build the writer; no pump/projectors needed (handlers never fire).
const runtime = createPathwayRuntime(
  env,
  new PostgresGenericEventRepository(db),
  new JMeldingChunkAssembler(
    db,
    new JMeldingFragmentProjector(env, usable),
    new JMeldingGeoProjector(db),
  ),
  new AreasProjector(new AreasRepository(db)),
  new SildelagetCatchProjector(new SildelagetCatchRepository(db)),
  { handleObserved: async () => {} } as never,
);
const source = createAisSource(env);
const state = new AisIngestStateRepository(db);
// Emit-only: MySQL → Flowcore. ClickHouse projection is the separate CH-refill
// job (in-app) or scripts/ais-stream.ts for ad-hoc.
const job = createAisBackfillJob(env, runtime.writer, source, state);

let stop = false;
let lastEmitted = 0;
let lastMessage = "";
const startedAt = performance.now();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (!stop) {
      console.log(
        "\n[backfill] stop requested — finishing current batch, then exiting…",
      );
      stop = true;
    }
  });
}

const ctx = {
  signal: new AbortController().signal,
  isStopRequested: () => stop,
  reportProgress: (p: {
    phase: string;
    message?: string;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => {
    if (typeof p.detailsProcessed === "number")
      lastEmitted = p.detailsProcessed;
    if (p.message) lastMessage = p.message;
  },
};

const heartbeat = setInterval(() => {
  const s = (performance.now() - startedAt) / 1000;
  const rate = lastEmitted / s;
  console.log(
    `[backfill] emitted=${lastEmitted.toLocaleString()} rate=${rate.toFixed(0)}/s | ${lastMessage}`,
  );
}, 30_000);

const to = new Date();
const from = new Date(to.getTime() - daysBack * 86_400_000);
console.log(
  `[backfill] window ${from.toISOString()} → ${to.toISOString()} (${daysBack}d) tenant=${env.FLOWCORE_TENANT} order=${order} bucketConcurrency=${bucketConcurrency || env.AIS_BACKFILL_BUCKET_CONCURRENCY}`,
);

const args = {
  startAt: from.toISOString(),
  endAt: to.toISOString(),
  bucketConcurrency, // 0 ⇒ env default (AIS_BACKFILL_BUCKET_CONCURRENCY)
  pageSize: 5000,
  batchSize: 0, // 0 ⇒ env default (AIS_BACKFILL_BATCH_SIZE)
  force: false,
  order: order as "asc" | "desc",
};

// Auto-resume loop: per-batch retries absorb short blips; if the job still
// throws (sustained failure), wait and re-run — it resumes from bucket state.
const MAX_JOB_RESTARTS = 50;
try {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await job(undefined, args, ctx);
      console.log(`[backfill] ${stop ? "stopped" : "done"}: ${res.message}`);
      break;
    } catch (err) {
      if (stop || attempt >= MAX_JOB_RESTARTS) {
        console.error(
          `[backfill] giving up after ${attempt} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
      console.error(
        `[backfill] job failed (attempt ${attempt}/${MAX_JOB_RESTARTS}), resuming in 30s: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
} finally {
  clearInterval(heartbeat);
  await closeAisPool().catch(() => {});
  await client.end().catch(() => {});
  releaseLock();
}
process.exit(0);
