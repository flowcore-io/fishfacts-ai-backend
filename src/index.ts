import { createApp } from "./app";
import { TokenCache } from "./auth/cache";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { loadEnv } from "./env";
import { PostgresGenericEventRepository } from "./events/repository";
import { FishfactsApiClient } from "./fishfacts/client";
import { JMeldingGeoProjector } from "./jmelding/geo-projector";
import { JMeldingGeoRepository } from "./jmelding/geo-repository";
import { JMeldingChunkAssembler } from "./jobs/jmelding-chunk-assembler";
import { JMeldingFragmentProjector } from "./jobs/jmelding-fragments";
import { createJobDefinitions } from "./jobs/registry";
import { JobRunner } from "./jobs/runner";
import { JobScheduler } from "./jobs/scheduler";
import { JobStateStore } from "./jobs/state-store";
import { createPathwayRuntime } from "./pathways";
import { UsableApiClient } from "./usable/client";

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
await runMigrations(db, client);
const repository = new PostgresGenericEventRepository(db);
const usable = new UsableApiClient(env);
const jmeldingProjector = new JMeldingFragmentProjector(env, usable);
const geoProjector = new JMeldingGeoProjector(db);
const geoRepository = new JMeldingGeoRepository(db);
const chunkAssembler = new JMeldingChunkAssembler(
  db,
  jmeldingProjector,
  geoProjector,
);
const pathways = createPathwayRuntime(env, repository, chunkAssembler);
const jobs = createJobDefinitions(env, pathways.writer, usable);
const jobStateStore = new JobStateStore(env, usable, jobs);
const jobRunner = new JobRunner(jobs, jobStateStore);
const jobScheduler = new JobScheduler(env, jobRunner);
const fishfactsClient = new FishfactsApiClient(env);
const authCache = new TokenCache(env.AUTH_CACHE_TTL_MS);
const app = createApp({
  repository,
  pathways,
  jobRunner,
  jobStateStore,
  fishfactsClient,
  authCache,
  geoRepository,
});

await pathways.startPump();
jobScheduler.start();

const chunkCleanupInterval = setInterval(
  () => {
    chunkAssembler
      .cleanupExpired()
      .then((count) => {
        if (count > 0) {
          console.log("[Chunks] cleaned up expired queue rows", { count });
        }
      })
      .catch((error) => {
        console.error("[Chunks] cleanup failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  },
  5 * 60 * 1000,
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    clearInterval(chunkCleanupInterval);
    jobScheduler.stop();
    await pathways.stopPump();
    await client.end();
    process.exit(0);
  });
}

export default {
  port: env.PORT,
  idleTimeout: 255,
  fetch: app.fetch,
};
