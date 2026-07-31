import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 10 });
  return {
    client,
    db: drizzle(client, { schema }),
  };
}

/**
 * A `timestamptz` as an ISO 8601 instant, whichever shape the driver hands back.
 *
 * It is not consistent: the same column arrives as a `Date` down some paths and
 * as Postgres' own rendering — `"2024-04-26 00:00:00+00"` — down others. So a
 * field typed `Date | null` and read with `value?.toISOString()` looks correct,
 * typechecks, passes tests written against `new Date(...)` fixtures, and throws
 * `toISOString is not a function` the first time it meets real data. Normalise
 * here rather than at each call site, and type such fields `Date | string`.
 *
 * An unparseable value is passed through unchanged rather than dropped: losing
 * a date silently is worse than surfacing one we cannot interpret.
 */
export function timestampToIso(
  value: Date | string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}
