import type { AisClickhouseRepository } from "@/ais/clickhouse-repository";
import type { FlowcoreBucketReader } from "@/ais/flowcore-bucket-reader";
import type { AisIngestStateRepository } from "@/ais/ingest-state-repository";
import { createAisBackfillJob } from "@/ais/job-backfill";
import { createAisChRefillJob } from "@/ais/job-ch-refill";
import { createAisTailJob } from "@/ais/job-tail";
import type { AisSource } from "@/ais/types";
import type { Env } from "@/env";
import type { VesselDirectory } from "@/fishfacts/vessel-directory";
import { createOpenRouterReader } from "@/logasavn/reader";
import type { PathwayWriter } from "@/pathways";
import type { SildelagetAisAnchorRepository } from "@/sildelaget/ais-anchor-repository";
import type { SildelagetCatchRepository } from "@/sildelaget/repository";
import type { UsableApiClient } from "@/usable/client";
import { z } from "zod";
import { createFiskeridirJMeldingerJob } from "./fiskeridir-jmeldinger";
import { createFiskistofaWfsClosuresJob } from "./fiskistofa-wfs-closures";
import { createGebcoIngestJob } from "./gebco-ingest";
import { createGillnetPositionsJob } from "./gillnet-positions";
import { createLogasavnClosuresJob } from "./logasavn-closures";
import { createLogasavnSweepJob } from "./logasavn-sweep";
import { createSildelagetAisAnchorsJob } from "./sildelaget-ais-anchors";
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
  sildelagetAisAnchorRepository: SildelagetAisAnchorRepository,
  vesselDirectory: VesselDirectory,
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
      id: "gillnet-positions",
      name: "Faroese gillnet positions collector (Vørn)",
      // Daily at 07:00 UTC — the feed updates ~06:23.
      schedule: "0 7 * * *",
      inputSchema: z.object({
        refreshExisting: z.coerce.boolean().default(false),
      }),
      execute: createGillnetPositionsJob(env, writer),
    },
    {
      id: "logasavn-sweep",
      name: "Lógasavn corpus index (Faroese statutes mentioning coordinates)",
      // 05:00 UTC, after the upstream logir.fo scrape, which timestamps its
      // fragments around 04:00 (`scraped_at: 2026-07-24T06:00:24Z` on a 04:02
      // pass).
      //
      // DAILY, and that is the point rather than a convenience. The index
      // carries a `scanned_at` stamp and tells its reader to search the corpus
      // directly for anything after that date — so a stale index does not lie,
      // it just stops being worth reading, and everything degrades to the cold
      // search it was measured against. Left unscheduled it would go stale from
      // the day it was published while the corpus kept growing underneath it.
      schedule: "0 5 * * *",
      inputSchema: z.object({
        // Classify and log the counts, publish nothing. For checking a detector
        // change against the live corpus without moving the index.
        dryRun: z.coerce.boolean().default(false),
      }),
      execute: createLogasavnSweepJob(env, usable),
    },
    {
      id: "logasavn-closures",
      name: "Lógasavn statutory closures (Faroese statute geometry)",
      // Manual only for now — impossible date (Feb 31) ⇒ the scheduler never
      // fires it; run via POST /api/jobs/run, `dryRun: true` first.
      //
      // Deliberately not scheduled yet. It costs an LLM call per statute and
      // the first passes are for looking at the output by eye; a job that draws
      // on a fisherman's chart earns its schedule after someone has checked what
      // it draws, not before. It also has to run AFTER `logasavn-sweep` (05:00),
      // whose index it reads.
      schedule: "0 0 31 2 *",
      inputSchema: z.object({
        // Read, compare and log; emit nothing. The counts alone answer "would
        // this have drawn the right things".
        dryRun: z.coerce.boolean().default(true),
        // `number/year`, e.g. `["30/2018"]`. Defaults to the first-pass set.
        statutes: z.array(z.string()).optional(),
      }),
      execute: createLogasavnClosuresJob(
        env,
        writer,
        usable,
        createOpenRouterReader(env),
      ),
    },
    {
      id: "gebco-ingest",
      name: "GEBCO undersea feature names ingester",
      // Static reference data — impossible date (Feb 31) ⇒ never auto-scheduled;
      // run manually via POST /api/jobs/run when GEBCO republishes.
      schedule: "0 0 31 2 *",
      inputSchema: z.object({
        refreshExisting: z.coerce.boolean().default(false),
      }),
      execute: createGebcoIngestJob(env, writer),
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
      id: "sildelaget-ais-anchors",
      name: "Sildelaget derived catch positions",
      // 20 past the hour: the catch-journal collector runs on the hour, so a
      // report is normally derived within the same hour it lands.
      schedule: "20 * * * *",
      inputSchema: z.object({
        // 0 = use env default (SILDELAGET_AIS_ANCHOR_WINDOW_DAYS).
        windowDays: z.coerce.number().int().min(0).default(0),
        // Re-derive rows that are already current — needed after a threshold
        // change lands outside the params hash, and for one-off backfills.
        recompute: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).default(5000),
        // Both 0 = use the AIS_ANCHOR_RETRY_* defaults. A report stored with a
        // non-ok status is re-derived at most once per retryAfterHours, and
        // only while it is younger than retryWithinDays.
        retryAfterHours: z.coerce.number().min(0).default(0),
        retryWithinDays: z.coerce.number().int().min(0).default(0),
      }),
      execute: createSildelagetAisAnchorsJob(env, {
        anchors: sildelagetAisAnchorRepository,
        vessels: vesselDirectory,
        fixes: aisChRepo,
      }),
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
