/**
 * Cloud SQL connection pools for the AIS replica, split by role so the live tail
 * and the historical backfill NEVER share connections. Previously a single
 * 2-connection pool was a global read semaphore shared by both: the backfill's
 * bucket workers monopolised the connections and the live tail starved (falling
 * hours behind realtime even though the replica was current). Each role now gets
 * its own pool sized independently — backfill reads can never block live reads.
 */
import type { Env } from "@/env";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql, { type Pool } from "mysql2/promise";

export type AisPoolRole = "live" | "backfill";

// One shared connector (cheap; just resolves TLS/auth options) feeds both pools.
let connector: Connector | null = null;
const pools: Partial<Record<AisPoolRole, Pool>> = {};
const initPromises: Partial<Record<AisPoolRole, Promise<Pool>>> = {};

function connectionLimit(env: Env, role: AisPoolRole): number {
  return role === "live"
    ? env.AIS_LIVE_DB_MAX_CONNECTIONS
    : env.AIS_DB_MAX_CONNECTIONS;
}

export function getAisPool(
  env: Env,
  role: AisPoolRole = "backfill",
): Promise<Pool> {
  const existing = pools[role];
  if (existing) return Promise.resolve(existing);
  const pending = initPromises[role];
  if (pending) return pending;
  const init = (async () => {
    if (
      !env.AIS_DB_INSTANCE_CONNECTION_NAME ||
      !env.AIS_DB_USER ||
      !env.AIS_DB_PASSWORD
    ) {
      throw new Error(
        "AIS MySQL source requires AIS_DB_INSTANCE_CONNECTION_NAME, AIS_DB_USER, AIS_DB_PASSWORD",
      );
    }
    if (!connector) connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: env.AIS_DB_INSTANCE_CONNECTION_NAME,
      ipType:
        env.AIS_DB_IP_TYPE === "PRIVATE"
          ? IpAddressTypes.PRIVATE
          : IpAddressTypes.PUBLIC,
    });
    const p = mysql.createPool({
      ...clientOpts,
      user: env.AIS_DB_USER,
      password: env.AIS_DB_PASSWORD,
      database: env.AIS_DB_NAME,
      connectionLimit: connectionLimit(env, role),
      waitForConnections: true,
      // Return DATETIME/TIMESTAMP as raw 'YYYY-MM-DD HH:MM:SS' strings (the
      // replica session is UTC) — deterministic, no local-tz interpretation.
      dateStrings: true,
    });
    pools[role] = p;
    return p;
  })();
  initPromises[role] = init;
  return init;
}

/** Close every pool + the connector — required or the Bun process won't exit. */
export async function closeAisPool(): Promise<void> {
  const open = Object.values(pools).filter((p): p is Pool => Boolean(p));
  const c = connector;
  for (const role of Object.keys(pools) as AisPoolRole[]) delete pools[role];
  for (const role of Object.keys(initPromises) as AisPoolRole[])
    delete initPromises[role];
  connector = null;
  await Promise.all(open.map((p) => p.end()));
  if (c) c.close();
}
