import type { AisClickhouseRepository } from "@/ais/clickhouse-repository";
import type { FlowcoreBucketReader } from "@/ais/flowcore-bucket-reader";
import type { AisIngestStateRepository } from "@/ais/ingest-state-repository";
import { createAisBackfillJob } from "@/ais/job-backfill";
import { createAisChRefillJob } from "@/ais/job-ch-refill";
import { createAisTailJob } from "@/ais/job-tail";
import type { AisSource } from "@/ais/types";
import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import type { SildelagetCatchRepository } from "@/sildelaget/repository";
import type { UsableApiClient } from "@/usable/client";
import { z } from "zod";
import { createFiskeridirJMeldingerJob } from "./fiskeridir-jmeldinger";
import { createFiskistofaWfsClosuresJob } from "./fiskistofa-wfs-closures";
import { createSildelagetCatchJournalJob } from "./sildelaget-catchjournal";
import type { JobDefinition } from "./types";
import { createVornVeidibannJob } from "./vorn-veidibann";

export function createJobDefinitions(
  env: Env,
  writer: PathwayWriter,
  usable: UsableApiClient,
  sildelagetCatchRepository: SildelagetCatchRepository,
  aisLiveSource: AisSource,
  aisBackfillSource: AisSource,
  aisIngestState: AisIngestStateRepository,
  aisChRepo: AisClickhouseRepository,
  aisBucketReader: FlowcoreBucketReader,
): JobDefinition[] {
  return [
    {
      id: "fiskeridir-jmeldinger",
      name: "Fiskeridir J-meldinger collector",
      schedule: "0 * * * *",
      inputSchema: z.object({
        maxItems: z.coerce.number().int().min(1).default(10000),
        maxPages: z.coerce.number().int().min(1).default(500),
        includeArchived: z.coerce.boolean().default(true),
        refreshExisting: z.coerce.boolean().default(false),
      }),
      execute: createFiskeridirJMeldingerJob(env, writer, {
        loadKnownKeys: () =>
          usable.listFragmentKeys({
            workspaceId: env.USABLE_WORKSPACE_ID,
            fragmentTypeId: env.JMELDING_FRAGMENT_TYPE_ID,
            status: "active",
          }),
      }),
    },
    {
      id: "vorn-veidibann",
      name: "Vørn veiðibann collector (Faroe Islands)",
      schedule: "0 * * * *",
      inputSchema: z.object({
        maxItems: z.coerce.number().int().min(1).default(1000),
        refreshExisting: z.coerce.boolean().default(false),
      }),
      execute: createVornVeidibannJob(env, writer, {
        loadKnownKeys: () =>
          usable.listFragmentKeys({
            workspaceId: env.USABLE_WORKSPACE_ID,
            fragmentTypeId: env.JMELDING_FRAGMENT_TYPE_ID,
            status: "active",
          }),
      }),
    },
    {
      id: "fiskistofa-wfs-closures",
      name: "Fiskistofa WFS closures collector (Iceland)",
      schedule: "0 * * * *",
      inputSchema: z.object({
        refreshExisting: z.coerce.boolean().default(false),
      }),
      execute: createFiskistofaWfsClosuresJob(env, writer),
    },
    {
      id: "sildelaget-catchjournal",
      name: "Sildelaget catch journal collector",
      schedule: "0 * * * *",
      inputSchema: z.object({
        selectedTime: z.coerce.number().int().min(1).default(168),
        selectedSpecies: z.string().default(""),
        selectedCatchType: z.string().default(""),
        isNor: z.coerce.boolean().default(true),
        backfill: z.coerce.boolean().default(false),
      }),
      execute: createSildelagetCatchJournalJob(
        env,
        writer,
        sildelagetCatchRepository,
      ),
    },
    {
      id: "ais-position-tail",
      name: "AIS position tail",
      schedule: "* * * * *",
      inputSchema: z.object({
        batchSize: z.coerce.number().int().min(1).default(1000),
        maxBatches: z.coerce.number().int().min(1).default(50),
        lookbackSeconds: z.coerce.number().int().min(0).default(5),
        // 0 = use env default (AIS_TAIL_EMIT_CONCURRENCY). min(0) so parse({})
        // — e.g. /api/jobs/state defaultArgs — doesn't reject the sentinel.
        emitConcurrency: z.coerce.number().int().min(0).default(0),
      }),
      execute: createAisTailJob(env, writer, aisLiveSource, aisIngestState),
    },
    {
      id: "ais-position-backfill",
      name: "AIS position backfill",
      // Impossible date (Feb 31) ⇒ scheduler never fires it; manual only.
      schedule: "0 0 31 2 *",
      inputSchema: z.object({
        startAt: z.string().datetime().optional(),
        endAt: z.string().datetime().optional(),
        // 0 = use env default. min(0) so parse({}) (e.g. /api/jobs/state
        // defaultArgs) accepts the sentinel instead of throwing on min(1).
        bucketConcurrency: z.coerce.number().int().min(0).default(0),
        pageSize: z.coerce.number().int().min(1).default(5000),
        batchSize: z.coerce.number().int().min(0).default(0),
        force: z.coerce.boolean().default(false),
        order: z.enum(["asc", "desc"]).default("asc"),
      }),
      execute: createAisBackfillJob(
        env,
        writer,
        aisBackfillSource,
        aisIngestState,
      ),
    },
    {
      id: "ais-position-ch-refill",
      name: "AIS ClickHouse refill",
      // Manual/supervisor-driven only (never scheduled). Consumes emitted
      // buckets and projects them Flowcore → ClickHouse.
      schedule: "0 0 31 2 *",
      inputSchema: z.object({
        concurrency: z.coerce.number().int().min(0).default(0),
        // Dense recent buckets blow past the fetch deadline at 5k+; 2k stays under
        // it even with live emit contention. The reader shrinks further per-bucket
        // if needed (adaptive), and sparse historical buckets are cheap at 2k too.
        pageSize: z.coerce.number().int().min(1).default(2000),
        order: z.enum(["asc", "desc"]).default("desc"),
      }),
      execute: createAisChRefillJob(
        env,
        aisBucketReader,
        aisChRepo,
        aisIngestState,
      ),
    },
  ];
}
