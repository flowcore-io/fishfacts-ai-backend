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
