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
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
