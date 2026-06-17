/**
 * Single shared Cloud SQL connection pool for the AIS replica. The 2-connection
 * cap is a GLOBAL read semaphore: tail + backfill both go through this one pool,
 * so at most `AIS_DB_MAX_CONNECTIONS` MySQL reads run at once.
 */
import type { Env } from "@/env";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import mysql, { type Pool } from "mysql2/promise";

let connector: Connector | null = null;
let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

export function getAisPool(env: Env): Promise<Pool> {
  if (pool) return Promise.resolve(pool);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (
      !env.AIS_DB_INSTANCE_CONNECTION_NAME ||
      !env.AIS_DB_USER ||
      !env.AIS_DB_PASSWORD
    ) {
      throw new Error(
        "AIS MySQL source requires AIS_DB_INSTANCE_CONNECTION_NAME, AIS_DB_USER, AIS_DB_PASSWORD",
      );
    }
    const c = new Connector();
    const clientOpts = await c.getOptions({
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
      connectionLimit: env.AIS_DB_MAX_CONNECTIONS,
      waitForConnections: true,
      // Return DATETIME/TIMESTAMP as raw 'YYYY-MM-DD HH:MM:SS' strings (the
      // replica session is UTC) — deterministic, no local-tz interpretation.
      dateStrings: true,
    });
    connector = c;
    pool = p;
    return p;
  })();
  return initPromise;
}

/** Close pool + connector — required or the Bun process won't exit. */
export async function closeAisPool(): Promise<void> {
  const p = pool;
  const c = connector;
  pool = null;
  connector = null;
  initPromise = null;
  if (p) await p.end();
  if (c) c.close();
}
