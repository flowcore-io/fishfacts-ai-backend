// One-off script: trigger the fiskeridir-jmeldinger job with refreshExisting=true and includeArchived=true,
// so every announcement (including the historical archive) is re-emitted as a Flowcore event.
//
// Uses production Flowcore credentials from .env (FLOWCORE_API_KEY, FLOWCORE_DATA_CORE_ID),
// local Postgres for job state, and prod Usable for fragment tracking. Idempotent at the data layer.

import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { loadEnv } from "../src/env";
import { JMeldingGeoProjector } from "../src/jmelding/geo-projector";
import { JMeldingChunkAssembler } from "../src/jobs/jmelding-chunk-assembler";
import { JMeldingFragmentProjector } from "../src/jobs/jmelding-fragments";
import { createJobDefinitions } from "../src/jobs/registry";
import { JobRunner } from "../src/jobs/runner";
import { JobStateStore } from "../src/jobs/state-store";
import { createPathwayRuntime } from "../src/pathways";
import { UsableApiClient } from "../src/usable/client";

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
await runMigrations(db, client);
const usable = new UsableApiClient(env);
const fragmentProjector = new JMeldingFragmentProjector(env, usable);
const geoProjector = new JMeldingGeoProjector(db);
const chunkAssembler = new JMeldingChunkAssembler(
  db,
  fragmentProjector,
  geoProjector,
);
const pathways = createPathwayRuntime(
  env,
  // generic event repo is not used by this job — pass a no-op stub
  {
    async upsertFromEvent() {},
    async findById() {
      return null;
    },
  },
  chunkAssembler,
);
const jobs = createJobDefinitions(env, pathways.writer, usable);
const stateStore = new JobStateStore(env, usable, jobs);
const runner = new JobRunner(jobs, stateStore);

console.log(
  "[refresh-scrape] Starting fiskeridir-jmeldinger with refreshExisting=true, includeArchived=true",
);
console.log(
  "[refresh-scrape] Tenant:",
  env.FLOWCORE_TENANT,
  "DataCore:",
  env.FLOWCORE_DATA_CORE_ID,
);

const started = await runner.startJob("fiskeridir-jmeldinger", "manual", {
  refreshExisting: true,
  includeArchived: true,
  maxItems: 100000,
  maxPages: 1000,
});
console.log("[refresh-scrape] Started runId:", started.runId);

const progressInterval = setInterval(async () => {
  const loaded = await stateStore.load("fiskeridir-jmeldinger");
  const p = loaded.state.job.progress;
  if (p) {
    console.log(
      `[refresh-scrape] phase=${p.phase} pct=${p.percent ?? "?"}% items=${p.itemsDiscovered ?? "?"} processed=${p.detailsProcessed ?? "?"}/${p.detailsTotal ?? "?"} ${p.message ?? ""}`,
    );
  }
}, 15000);

try {
  await started.promise;
  clearInterval(progressInterval);
  console.log("[refresh-scrape] DONE");
} catch (err) {
  clearInterval(progressInterval);
  console.error("[refresh-scrape] FAILED", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
