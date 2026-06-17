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
  USABLE_API_TOKEN: z.string().min(1),
  JMELDING_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("68505bca-a549-45eb-bca6-965f87195b89"),
  JOB_STATE_FRAGMENT_TYPE_ID: z
    .string()
    .uuid()
    .default("11da02d0-b033-43a4-acd1-96f9e193cc86"),
  JOB_SCHEDULER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  JOB_SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(30000),
  JOB_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
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
  FISHFACTS_API_BASE_URL: z
    .string()
    .url()
    .default("https://api-test.fishfacts.fo"),
  FISHFACTS_APPLICATION: z.string().min(1).default("FISHFACTS"),
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
  // Hard timeout for a single batch emit. The SDK webhook fetch has no timeout,
  // so a hung connection would stall a worker forever; on timeout we throw →
  // the per-batch retry kicks in instead of wedging.
  AIS_EMIT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
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
  AIS_CH_BATCH_ROWS: z.coerce.number().int().positive().default(5000),
  AIS_CH_FLUSH_MS: z.coerce.number().int().positive().default(2000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
