import type { Env } from "@/env";
import { type ClickHouseClient, createClient } from "@clickhouse/client";

/**
 * Main ClickHouse client (database-scoped). The projector batches inserts
 * app-side (thousands of rows per request), so no async_insert is needed.
 *
 * keep_alive.idle_socket_ttl MUST be below ClickHouse's keep_alive_timeout
 * (3s by default) — otherwise the client reuses a socket the server already
 * closed and the insert fails with ECONNRESET under sustained load.
 */
export function createClickhouseClient(env: Env): ClickHouseClient {
  return createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DATABASE,
    max_open_connections: 10,
    keep_alive: { enabled: true, idle_socket_ttl: 2500 },
  });
}
