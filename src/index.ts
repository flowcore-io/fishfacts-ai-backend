import { AisBackfillSupervisor } from "./ais/backfill-supervisor";
import { createClickhouseClient } from "./ais/clickhouse-client";
import { runClickhouseMigrations } from "./ais/clickhouse-migrate";
import { AisClickhouseRepository } from "./ais/clickhouse-repository";
import { FlowcoreBucketReader } from "./ais/flowcore-bucket-reader";
import { AisIngestStateRepository } from "./ais/ingest-state-repository";
import { closeAisPool } from "./ais/mysql-pool";
import { AisPositionProjector } from "./ais/projector";
import { createAisSource } from "./ais/source";
import { createApp } from "./app";
import { AreasProjector } from "./areas/projector";
import { AreasRepository } from "./areas/repository";
import { TokenCache } from "./auth/cache";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { loadEnv } from "./env";
import { PostgresGenericEventRepository } from "./events/repository";
import { FinancialsRepository } from "./financials/repository";
import { FishfactsApiClient } from "./fishfacts/client";
import { GebcoProjector } from "./gebco/projector";
import { GebcoRepository } from "./gebco/repository";
import { GillnetProjector } from "./gillnet/projector";
import { GillnetRepository } from "./gillnet/repository";
import { JMeldingGeoProjector } from "./jmelding/geo-projector";
import { JMeldingGeoRepository } from "./jmelding/geo-repository";
import { JMeldingChunkAssembler } from "./jobs/jmelding-chunk-assembler";
import { JMeldingFragmentProjector } from "./jobs/jmelding-fragments";
import { createJobDefinitions } from "./jobs/registry";
import { JobRunner } from "./jobs/runner";
import { JobScheduler } from "./jobs/scheduler";
import { seedJobStateFromUsable } from "./jobs/seed-from-usable";
import { JobStateStore } from "./jobs/state-store";
import { createPathwayRuntime } from "./pathways";
import { PoiFragmentProjector } from "./poi/fragment-projector";
import { PoiRepository } from "./poi/repository";
import { makeReportsClient, reportsConfigFromEnv } from "./reports/client";
import { SildelagetCatchProjector } from "./sildelaget/projector";
import { SildelagetCatchRepository } from "./sildelaget/repository";
import { TilesRepository } from "./tiles/repository";
import { UsableApiClient } from "./usable/client";

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
await runMigrations(db, client);
const repository = new PostgresGenericEventRepository(db);
const usable = new UsableApiClient(env);
const jmeldingProjector = new JMeldingFragmentProjector(env, usable);
const geoProjector = new JMeldingGeoProjector(db);
const geoRepository = new JMeldingGeoRepository(db);
const gillnetProjector = new GillnetProjector(db);
const gillnetRepository = new GillnetRepository(db);
const gebcoProjector = new GebcoProjector(db);
const gebcoRepository = new GebcoRepository(db);
const poiRepository = new PoiRepository(usable, env);
// Invalidation hook: a durable POI write becomes servable on the next
// GET /api/poi instead of waiting out the read cache's 5-min TTL.
const poiFragmentProjector = new PoiFragmentProjector(env, usable, () =>
  poiRepository.invalidate(),
);
const tilesRepository = new TilesRepository(db);
const areasRepository = new AreasRepository(db);
const areasProjector = new AreasProjector(areasRepository);
const sildelagetCatchRepository = new SildelagetCatchRepository(db);
const financialsRepository = new FinancialsRepository(env, db);
const sildelagetCatchProjector = new SildelagetCatchProjector(
  sildelagetCatchRepository,
);
const chunkAssembler = new JMeldingChunkAssembler(
  db,
  jmeldingProjector,
  geoProjector,
);

// AIS read model (ClickHouse). Migration failure is non-fatal so the core
// service still boots if ClickHouse is down; AIS projection retries via the pump.
const chClient = createClickhouseClient(env);
try {
  await runClickhouseMigrations(env);
} catch (error) {
  console.error("[AIS] ClickHouse migration failed (continuing)", {
    message: error instanceof Error ? error.message : String(error),
  });
}
const aisChRepo = new AisClickhouseRepository(chClient, env);
const aisProjector = new AisPositionProjector(aisChRepo);
// Two sources, two MySQL pools: the live tail and the historical backfill never
// share connections, so backfill reads can't starve the live tail.
const aisLiveSource = createAisSource(env, "live");
const aisBackfillSource = createAisSource(env, "backfill");
const aisIngestState = new AisIngestStateRepository(db);
// Reads emitted AIS events back from Flowcore (fetch API) so the backfill can
// project history the forward-only pump cursor will never replay.
const aisBucketReader = new FlowcoreBucketReader(env);

const pathways = createPathwayRuntime(
  env,
  repository,
  chunkAssembler,
  areasProjector,
  sildelagetCatchProjector,
  aisProjector,
  gillnetProjector,
  gebcoProjector,
  poiFragmentProjector,
);
const jobs = createJobDefinitions(
  env,
  pathways.writer,
  usable,
  sildelagetCatchRepository,
  aisLiveSource,
  aisBackfillSource,
  aisIngestState,
  aisChRepo,
  aisBucketReader,
);
const jobStateStore = new JobStateStore(db, jobs);
const jobRunner = new JobRunner(jobs, jobStateStore, env);
const jobScheduler = new JobScheduler(env, jobRunner);
const aisBackfillSupervisor = new AisBackfillSupervisor(
  env,
  jobRunner,
  aisIngestState,
  client,
);
const fishfactsClient = new FishfactsApiClient(env);
const authCache = new TokenCache(env.AUTH_CACHE_TTL_MS);
const reportsConfig = reportsConfigFromEnv(env);
const reportsClient = reportsConfig
  ? makeReportsClient(usable, reportsConfig)
  : null;
const app = createApp({
  repository,
  pathways,
  jobRunner,
  jobStateStore,
  fishfactsClient,
  authCache,
  geoRepository,
  gillnetRepository,
  gebcoRepository,
  poiRepository,
  tilesRepository,
  areasRepository,
  sildelagetCatchRepository,
  financialsRepository,
  aisRepository: aisChRepo,
  aisIngestState,
  aisSource: aisBackfillSource,
  reportsClient,
  db,
});

await pathways.startPump();
// One-time migration of legacy Usable job-state fragments → Postgres. MUST run
// before the scheduler/supervisor so resume-dependent jobs don't start on empty
// state. Idempotent (only seeds jobs missing a row) and best-effort.
await seedJobStateFromUsable(db, usable, env, jobs).catch((error) => {
  console.error("[Jobs] seedJobStateFromUsable failed (jobs may start fresh)", {
    message: error instanceof Error ? error.message : String(error),
  });
});
jobScheduler.start();
aisBackfillSupervisor.start();

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
    aisBackfillSupervisor.stop();
    await pathways.stopPump();
    await aisChRepo.close().catch((error) => {
      console.error("[AIS] ClickHouse flush/close failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    aisBucketReader.close();
    await closeAisPool();
    await client.end();
    process.exit(0);
  });
}

export default {
  port: env.PORT,
  idleTimeout: 255,
  fetch: app.fetch,
};
