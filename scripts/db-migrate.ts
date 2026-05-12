import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend";

const { db, client } = createDb(url);
try {
  await runMigrations(db, client);
  console.log("[Migrations] up to date");
} finally {
  await client.end();
}
