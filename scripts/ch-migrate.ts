import { runClickhouseMigrations } from "../src/ais/clickhouse-migrate";
import { loadEnv } from "../src/env";

const env = loadEnv();
await runClickhouseMigrations(env);
console.log("[ClickHouse] schema up to date");
