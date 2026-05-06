import { createApp } from "./app";
import { createDb } from "./db/client";
import { loadEnv } from "./env";
import { PostgresGenericEventRepository } from "./events/repository";
import { JMeldingFragmentProjector } from "./jobs/jmelding-fragments";
import { createJobDefinitions } from "./jobs/registry";
import { JobRunner } from "./jobs/runner";
import { JobScheduler } from "./jobs/scheduler";
import { JobStateStore } from "./jobs/state-store";
import { createPathwayRuntime } from "./pathways";
import { UsableApiClient } from "./usable/client";

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
const repository = new PostgresGenericEventRepository(db);
const usable = new UsableApiClient(env);
const jmeldingProjector = new JMeldingFragmentProjector(env, usable);
const pathways = createPathwayRuntime(env, repository, jmeldingProjector);
const jobs = createJobDefinitions(env, pathways.writer, usable);
const jobStateStore = new JobStateStore(env, usable, jobs);
const jobRunner = new JobRunner(jobs, jobStateStore);
const jobScheduler = new JobScheduler(env, jobRunner);
const app = createApp({ repository, pathways, jobRunner, jobStateStore });

await pathways.startPump();
jobScheduler.start();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
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
