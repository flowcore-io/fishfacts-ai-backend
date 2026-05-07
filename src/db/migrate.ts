import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";
import type { Database } from "./client";

const MIGRATIONS_FOLDER = "./drizzle";

type JournalEntry = { idx: number; when: number; tag: string };

function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

function hashMigration(folder: string, tag: string): string {
  const sql = readFileSync(join(folder, `${tag}.sql`), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

async function legacyTablesExist(client: postgres.Sql): Promise<boolean> {
  const rows = await client<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'generic_events'
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

async function trackingTableEmpty(client: postgres.Sql): Promise<boolean> {
  const rows = await client<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM information_schema.tables
    WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
  `;
  if (rows[0]?.count === "0") return true;
  const tracking = await client<{ count: string }[]>`
    SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
  `;
  return tracking[0]?.count === "0";
}

async function backfillTracking(client: postgres.Sql, folder: string) {
  await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await client`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;
  for (const entry of readJournal(folder)) {
    const hash = hashMigration(folder, entry.tag);
    await client`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
  }
}

export async function runMigrations(db: Database, client: postgres.Sql) {
  if ((await legacyTablesExist(client)) && (await trackingTableEmpty(client))) {
    console.log(
      "[Migrations] legacy schema detected without tracking — backfilling __drizzle_migrations",
    );
    await backfillTracking(client, MIGRATIONS_FOLDER);
  }
  await drizzleMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
