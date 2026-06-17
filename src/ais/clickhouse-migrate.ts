/**
 * ClickHouse schema management (no Drizzle for CH). Idempotent CREATE … IF NOT
 * EXISTS — safe to run on every boot. Run after Postgres migrations, before the
 * pump starts, so the projector always has its table.
 */
import type { Env } from "@/env";
import { createClient } from "@clickhouse/client";

export async function runClickhouseMigrations(env: Env): Promise<void> {
  const db = env.CLICKHOUSE_DATABASE;

  // CREATE DATABASE via a client with no database scope ('default' always exists).
  const admin = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
  });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS \`${db}\`` });
  } finally {
    await admin.close();
  }

  const client = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: db,
  });
  try {
    // Raw fact table — ReplacingMergeTree keyed by the full sort key (source_id
    // last makes it unique) ⇒ replays/redelivery converge to one row.
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ais_position_fixes (
          source_id        UInt64,
          vessel_id        Int32,
          vessel_source_id Nullable(Int32),
          latitude         Float64,
          longitude        Float64,
          speed            Nullable(Float64),
          heading          Nullable(Float64),
          course           Nullable(Float64),
          status           LowCardinality(Nullable(String)),
          event_time       DateTime64(3, 'UTC'),
          ingest_time      DateTime64(3, 'UTC'),
          observed_at      DateTime64(3, 'UTC'),
          source           LowCardinality(String),
          _version         DateTime64(3, 'UTC') DEFAULT now64(3)
        )
        ENGINE = ReplacingMergeTree(_version)
        PARTITION BY toYYYYMM(event_time)
        ORDER BY (vessel_id, event_time, source_id)
      `,
    });

    // Daily-per-vessel rollup (makes "2-year daily aggregate" queries ms-fast).
    // v1: count + bbox. Speed aggregates can be added later.
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ais_vessel_daily (
          vessel_id Int32,
          day       Date,
          fixes     AggregateFunction(count),
          min_lat   AggregateFunction(min, Float64),
          max_lat   AggregateFunction(max, Float64),
          min_lon   AggregateFunction(min, Float64),
          max_lon   AggregateFunction(max, Float64)
        )
        ENGINE = AggregatingMergeTree
        ORDER BY (vessel_id, day)
      `,
    });
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ais_vessel_daily_mv
        TO ais_vessel_daily AS
        SELECT
          vessel_id,
          toDate(event_time) AS day,
          countState()       AS fixes,
          minState(latitude)  AS min_lat,
          maxState(latitude)  AS max_lat,
          minState(longitude) AS min_lon,
          maxState(longitude) AS max_lon
        FROM ais_position_fixes
        GROUP BY vessel_id, day
      `,
    });
  } finally {
    await client.close();
  }
}
