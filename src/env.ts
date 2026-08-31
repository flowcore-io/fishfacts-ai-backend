import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  FLOWCORE_TENANT: z.string().min(1),
  FLOWCORE_DATA_CORE: z.string().min(1),
  FLOWCORE_DATA_CORE_ID: z.string().uuid().optional(),
  FLOWCORE_API_URL: z.string().url().default("https://webhook.api.flowcore.io"),
  FLOWCORE_API_KEY: z.string().startsWith("fc_"),
  FLOWCORE_TRANSFORMER_SECRET: z.string().min(1),
  PUMP_RESET_SECRET: z.string().min(1),
  SERVICE_URL: z.string().url().optional(),
  USABLE_WORKSPACE_ID: z.string().uuid(),
  USABLE_API_BASE_URL: z.string().url().default("https://usable.dev/api"),
  // Historic-chart raster tiles live as public PMTiles archives in Usable
  // Assets and are read from here with range requests.
  ASSETS_PUBLIC_BASE_URL: z
    .string()
    .url()
    .default("https://assets-api.usable.dev"),
  USABLE_API_TOKEN: z.string().min(1),
  JMELDING_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("68505bca-a549-45eb-bca6-965f87195b89"),
  // "Point of Interest" fragments (Fishfacts Knowledge workspace) served as
  // the landmark gazetteer by GET /api/poi.
  POI_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("b816fad2-4918-46c1-80de-68a20e68f9ad"),
  JOB_STATE_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("11da02d0-b033-43a4-acd1-96f9e193cc86"),
  // Lógasavn — the Faroese law corpus (a mirror of logir.fo maintained by
  // someone else's ingest). READ-ONLY for us: the sweep reads every fragment
  // and writes none of them.
  LOGASAVN_WORKSPACE_ID: z
    .string()
    .uuid()
    .default("a2ae037c-5b45-4f06-924f-eb9fa4a8cc45"),
  LOGASAVN_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("67a1ae00-da83-4dfd-b540-9e2835fbc81f"),
  // Where the sweep publishes its index of coordinate-bearing statutes: a
  // "Knowledge" fragment in Fishfacts Knowledge (`USABLE_WORKSPACE_ID`), which
  // is the workspace the chat bot searches. Written by us, unlike the corpus.
  LOGASAVN_INDEX_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("ad920334-6c96-431e-9089-399f0dab8ebd"),
  // In-chat issue reports (PRD: In-Chat Issue Reporting & Session Capture)
  // land as fragments of a dedicated Report fragment type, ideally in a
  // support-scoped workspace. Both optional: without a fragment type id the
  // /api/reports routes answer 503 instead of the service failing boot;
  // without a workspace id reports fall back to USABLE_WORKSPACE_ID.
  REPORT_WORKSPACE_ID: z.string().uuid().optional(),
  REPORT_FRAGMENT_TYPE_ID: z.string().uuid().optional(),
  // The reader that turns a Lógasavn statute into labelled rings — an LLM,
  // because deciding that `øki a` is an exemption inside `Øki A` is a question
  // about Faroese prose, not about coordinates.
  //
  // OPTIONAL on purpose: without a key the service still boots and every other
  // job still runs, and only `logasavn-closures` refuses when it is invoked. A
  // required key would turn one missing credential into an outage for the whole
  // backend, which is a steep price for a job that runs once a day.
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  // The model 1st mate itself runs on — the default of embed config
  // `663e0bd7-62c3-4a83-95e2-5fa176f06952` (Johann, 2026-08-04). One model for
  // Faroese statutes across both halves of the product, so a reading that looks
  // wrong on the map can be reproduced by asking the assistant the same thing.
  //
  // The gate is what makes a fast model a reasonable choice here: every vertex
  // it quotes is checked against `extractAreas` and withheld on disagreement, so
  // a transcription slip costs coverage rather than correctness. What the gate
  // does NOT check is the `kind` label — see `compareReading`.
  LOGASAVN_READER_MODEL: z
    .string()
    .min(1)
    .default("google/gemini-3-flash-preview"),
  JOB_SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  JOB_SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30000),
  JOB_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Min interval between Usable job-state PATCHes for in-run PROGRESS updates.
  // Rapid reportProgress() calls (e.g. the AIS backfill emitting thousands of
  // rows/s) are coalesced to at most one write per this window — the start and
  // terminal saves always go through. Stops the job-state fragment from being
  // hammered (was ~6k PATCH/hr to one doc, dragging Usable's P95).
  JOB_PROGRESS_SAVE_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60000),
  FISKERIDIR_JMELDINGER_BASE_URL: z
    .string()
    .url()
    .default("https://www.fiskeridir.no/yrkesfiske/j-meldinger"),
  SILDELAGET_CATCHJOURNAL_EXPORT_URL: z
    .string()
    .url()
    .default(
      "https://www.sildelaget.no/umbraco/api/catchjournal/ExportCatchJournal",
    ),
  SILDELAGET_CATCHMAP_AREAS_URL: z
    .string()
    .url()
    .default("https://api.sildelaget.no/catchmap/MapService.svc/CatchAreas"),

  // Derived catch positions (sildelaget/ais-anchor.ts). What counts as
  // "fishing" — the speed band and the coverage-gap rule — is NOT here: those
  // are constants in ais/fishing-runs.ts, read by both this derivation and
  // /api/ais/effort, so the two cannot be configured into disagreeing. The
  // knobs below are operational: how far back to look, how far is too far, and
  // how much to chew per run.
  SILDELAGET_AIS_ANCHOR_LOOKBACK_HOURS: z.coerce
    .number()
    .positive()
    .default(48),
  /** A derived position further than this from the report is flagged. */
  SILDELAGET_AIS_ANCHOR_SANITY_KM: z.coerce.number().positive().default(150),
  /** IANA zone the innmeldingsjournal's dates and times are written in. */
  SILDELAGET_JOURNAL_TIME_ZONE: z.string().min(1).default("Europe/Oslo"),
  /** Backfill window for the anchor job — the bubble map shows 50 days. */
  SILDELAGET_AIS_ANCHOR_WINDOW_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(50),
  /** Reports per ClickHouse fix query. Bounds the OR-chain in one statement. */
  SILDELAGET_AIS_ANCHOR_BATCH_REPORTS: z.coerce
    .number()
    .int()
    .positive()
    .default(25),

  FISHFACTS_API_BASE_URL: z
    .string()
    .url()
    .default("https://api-test.fishfacts.fo"),
  FISHFACTS_APPLICATION: z.string().min(1).default("FISHFACTS"),
  /**
   * How long the vessel registry index (name / registration mark → vessel id)
   * is held in memory. It is read from the FishFacts MySQL replica through the
   * AIS pool, so this bounds how stale a newly registered vessel can be.
   */
  VESSEL_DIRECTORY_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
  AUTH_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60000),
  DISABLE_EVENT_STREAMING: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CLUSTER_PORT: z.coerce.number().int().positive().default(9090),
  POD_IP: z.string().min(1).default("127.0.0.1"),

  // AIS ingestion — MySQL replica (Cloud SQL Connector) → Flowcore → ClickHouse
  AIS_SOURCE: z.enum(["mysql", "kafka"]).default("mysql"),
  AIS_DB_INSTANCE_CONNECTION_NAME: z.string().min(1).optional(),
  AIS_DB_IP_TYPE: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
  AIS_DB_USER: z.string().min(1).optional(),
  AIS_DB_PASSWORD: z.string().min(1).optional(),
  AIS_DB_NAME: z.string().min(1).default("fishfacts"),
  AIS_DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(2),
  // Dedicated MySQL pool for the LIVE tail, separate from the backfill pool above
  // so backfill bucket reads can never starve the live tail (mysql-pool.ts). The
  // tail reads sequentially, so a small pool is plenty.
  AIS_LIVE_DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(2),
  AIS_TAIL_LOOKBACK_SECONDS: z.coerce.number().int().nonnegative().default(5),
  AIS_TAIL_EMIT_CONCURRENCY: z.coerce.number().int().positive().default(8),
  // Bucket workers run concurrently; each streams its bucket sequentially and
  // emits in batches. Reads stay capped at AIS_DB_MAX_CONNECTIONS (pool
  // throttles); concurrency drives emit throughput toward the webhook ceiling.
  AIS_BACKFILL_BUCKET_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .default(8),
  // Events per Flowcore batch ingest request. Webhook latency is per-request, so
  // bigger batches dominate throughput (~25/req ≈ 290/s vs ~500/req ≈ 3600/s).
  AIS_BACKFILL_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  // Concurrent workers for the CH-refill job (Flowcore → ClickHouse projection),
  // independent of the emit job's bucket concurrency.
  AIS_CH_REFILL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Hard timeout for a single batch emit. The SDK webhook fetch has no timeout,
  // so a hung connection would stall a worker forever; on timeout we throw →
  // the per-batch retry kicks in instead of wedging. The webhook ACKs the AIS
  // batch path in ~3s p99 (Groundcover), so ~10s is ample; a longer wait just
  // parks a worker when the client runtime is starved.
  AIS_EMIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Data-pump reserves `concurrency` events per process cycle and pays per-cycle
  // overhead (acknowledge + setState Postgres write). Small values throttle hard
  // (~8/cycle ≈ 200/s); reserve thousands to amortize. Must be <= AIS_PUMP_BUFFER_SIZE.
  AIS_PUMP_CONCURRENCY: z.coerce.number().int().positive().default(2000),
  // Pump fetch/buffer width (events pulled per getEvents call + held before processing).
  AIS_PUMP_BUFFER_SIZE: z.coerce.number().int().positive().default(10_000),
  // GOOGLE_APPLICATION_CREDENTIALS is read directly from process.env by the
  // Cloud SQL connector; declared here only for documentation/validation.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),

  // ClickHouse read model
  CLICKHOUSE_URL: z.string().url().default("http://localhost:8123"),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DATABASE: z.string().min(1).default("fishfacts_ais"),
  // Set to the CH cluster name (Altinity CHI cluster) to enable HA: DDL runs
  // ON CLUSTER with Replicated*MergeTree engines. Empty ⇒ single-node engines.
  CLICKHOUSE_CLUSTER: z.string().default(""),
  AIS_CH_BATCH_ROWS: z.coerce.number().int().positive().default(5000),
  AIS_CH_FLUSH_MS: z.coerce.number().int().positive().default(2000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
