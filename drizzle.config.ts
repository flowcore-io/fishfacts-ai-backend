import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:15432/fishfacts_ai_backend",
  },
  extensionsFilters: ["postgis"],
  tablesFilter: [
    "generic_events",
    "jmelding_*",
    "sildelaget_*",
    "ais_*",
    "job_*",
    "regulation_*",
    "!pathway_*",
  ],
});
