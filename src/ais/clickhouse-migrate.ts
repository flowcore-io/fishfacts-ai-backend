/**
 * ClickHouse schema management (no Drizzle for CH). Idempotent CREATE … IF NOT
 * EXISTS — safe to run on every boot. Run after Postgres migrations, before the
 * pump starts, so the projector always has its table.
 *
 * Replication: when `CLICKHOUSE_CLUSTER` is set (HA — ClickHouse Keeper + ≥2
 * replicas, e.g. the Altinity operator CHI), DDL runs `ON CLUSTER` and uses
 * `Replicated*MergeTree` engines so every replica gets the schema and the data
 * replicates. Empty (single-node / local docker) keeps the plain engines.
 * `{shard}`/`{replica}` are per-pod macros injected by the operator.
 */
import type { Env } from "@/env";
import { createClient } from "@clickhouse/client";

export async function runClickhouseMigrations(env: Env): Promise<void> {
  const db = env.CLICKHOUSE_DATABASE;
  const cluster = env.CLICKHOUSE_CLUSTER?.trim() ?? "";
  if (cluster && !/^[A-Za-z0-9_-]+$/.test(cluster)) {
    throw new Error(`invalid CLICKHOUSE_CLUSTER: ${cluster}`);
  }
  const onCluster = cluster ? ` ON CLUSTER '${cluster}'` : "";
  // Replicated engine + zookeeper path when clustered; plain engine otherwise.
  const engine = (base: string, table: string, ...extra: string[]): string => {
    if (cluster) {
      const args = [
        `'/clickhouse/tables/{shard}/${db}/${table}'`,
        "'{replica}'",
        ...extra,
      ];
      return `Replicated${base}(${args.join(", ")})`;
    }
    return extra.length ? `${base}(${extra.join(", ")})` : base;
  };

  // CREATE DATABASE via a client with no database scope ('default' always exists).
  const admin = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
  });
  try {
    await admin.command({
      query: `CREATE DATABASE IF NOT EXISTS \`${db}\`${onCluster}`,
    });
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
    // Raw fact table — (Replicated)ReplacingMergeTree keyed by the full sort key
    // (source_id last makes it unique) ⇒ replays/redelivery converge to one row.
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ais_position_fixes${onCluster} (
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
        ENGINE = ${engine("ReplacingMergeTree", "ais_position_fixes", "_version")}
        PARTITION BY toYYYYMM(event_time)
        ORDER BY (vessel_id, event_time, source_id)
      `,
    });

    // Daily-per-vessel rollup (makes "2-year daily aggregate" queries ms-fast).
    // v1: count + bbox. Speed aggregates can be added later.
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ais_vessel_daily${onCluster} (
          vessel_id Int32,
          day       Date,
          fixes     AggregateFunction(count),
          min_lat   AggregateFunction(min, Float64),
          max_lat   AggregateFunction(max, Float64),
          min_lon   AggregateFunction(min, Float64),
          max_lon   AggregateFunction(max, Float64)
        )
        ENGINE = ${engine("AggregatingMergeTree", "ais_vessel_daily")}
        ORDER BY (vessel_id, day)
      `,
    });
    // MV fires on the replica that receives an INSERT; its rollup rows land in
    // the Replicated target table and replicate to the other replica (the MV is
    // NOT re-triggered by replicated parts), so no double counting.
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ais_vessel_daily_mv${onCluster}
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
