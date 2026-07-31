/**
 * Bring the Usable J-announcement fragments back in line with `jmelding_geo`.
 *
 * One event fans out to both stores (`jmelding-chunk-assembler.ts` → fragment
 * projector, then geo projector), so the two normally agree. They stop
 * agreeing when the read model is repaired directly:
 * `jmelding-backfill-validity.ts` derives the window and the true status from
 * the stored title and writes them to Postgres only, leaving every fragment
 * still claiming `status: "current"` with an empty `valid_from`. The assistant
 * reaches regulations both ways — the geo tools and semantic search over these
 * fragments — so a fragment left behind can still report an expired notice as
 * in force.
 *
 * Re-scraping with `refreshExisting: true` would fix both stores properly, by
 * emitting new events with correct payloads. This is the cheap alternative: no
 * re-fetching of 6 800 source pages, no 6 800 re-emitted events.
 *
 * It does NOT hand-patch the YAML. A fragment states its status in five places
 * — frontmatter, the frontmatter `tags:` list, the rendered `## Metadata`
 * block, the API-level tags and the summary — so this rebuilds each fragment
 * through `JMeldingFragmentProjector`, the same code the pathway uses, from
 * the DB row plus the announcement body recovered out of the existing
 * fragment. The result is what a re-scrape would have written, minus the
 * scrape.
 *
 * Only fragments whose status or window actually differ are written: an update
 * re-embeds the fragment, so touching all of them to change none would be an
 * expensive no-op. That comparison, and the record each rebuild is fed, live in
 * `src/jmelding/fragment-sync.ts` so they are typechecked and unit-tested —
 * `scripts/` is neither. What is left here is the wiring: env, query, loop.
 *
 *   bun scripts/jmelding-sync-fragments.ts                  # dry run (differences only)
 *   bun scripts/jmelding-sync-fragments.ts --region NO      # scope by jurisdiction
 *   bun scripts/jmelding-sync-fragments.ts --limit 20 --apply
 *   bun scripts/jmelding-sync-fragments.ts --apply
 *
 * Run it AFTER `jmelding-backfill-validity.ts --apply` — it copies what the
 * database says, so the database has to be right first.
 */
import { createDb } from "../src/db/client";
import { loadEnv } from "../src/env";
import {
  type JMeldingGeoSyncRow,
  decideFragmentSync,
  isoInstant,
  parseLimitFlag,
} from "../src/jmelding/fragment-sync";
import { JMeldingFragmentProjector } from "../src/jobs/jmelding-fragments";
import { UsableApiClient } from "../src/usable/client";

const APPLY = process.argv.includes("--apply");
const flagValue = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const REGION = flagValue("--region")?.toUpperCase();
if (REGION && !["NO", "FO", "IS"].includes(REGION)) {
  throw new Error(`--region must be one of NO, FO, IS (got "${REGION}")`);
}
const LIMIT = parseLimitFlag(flagValue("--limit"));

const env = loadEnv();

const { client } = createDb(env.DATABASE_URL);
const usable = new UsableApiClient(env);
const projector = new JMeldingFragmentProjector(env, usable);

try {
  const rows = (await client`
    SELECT jm_number, fragment_key, title, status, region, category, url, signature,
           valid_from, valid_to
    FROM jmelding_geo
    ${REGION ? client`WHERE region = ${REGION}` : client``}
    ORDER BY jm_number DESC
  `) as unknown as JMeldingGeoSyncRow[];

  console.log(
    `[SyncFragments] ${rows.length} rows in the read model${REGION ? ` (region ${REGION})` : ""}`,
  );

  let checked = 0;
  let missing = 0;
  let unrecoverable = 0;
  let synced = 0;
  const samples: string[] = [];

  for (const row of rows) {
    if (synced >= LIMIT) break;
    const fragment = await usable.getFragmentByKey(
      env.USABLE_WORKSPACE_ID,
      row.fragment_key,
    );
    checked += 1;
    if (!fragment) {
      missing += 1;
      continue;
    }

    const decision = decideFragmentSync(row, fragment.content);
    if (decision.action === "in-sync") continue;
    // Reported in the dry run too: a fragment that cannot be rebuilt without
    // losing its announcement is exactly what you want to hear about before
    // deciding to write anything.
    if (decision.action === "unrecoverable") {
      unrecoverable += 1;
      console.warn(
        `[SyncFragments] ${row.jm_number}: ${decision.reason} (${row.fragment_key}) — skipped`,
      );
      continue;
    }

    synced += 1;
    if (samples.length < 5) {
      samples.push(
        `  ${row.jm_number}: status ${decision.claims.status ?? "—"} → ${row.status}, valid_to ${decision.claims.validTo ?? "—"} → ${isoInstant(row.valid_to) ?? "—"}`,
      );
    }
    if (APPLY) await projector.project(decision.announcement);
  }

  console.log(
    `[SyncFragments] checked ${checked}, ${missing} with no fragment, ${unrecoverable} unrecoverable, ${synced} ${APPLY ? "rewritten" : "out of sync"}`,
  );
  for (const sample of samples) console.log(sample);
  if (!APPLY) {
    console.log("[SyncFragments] dry run — pass --apply to write");
  }
} finally {
  await client.end();
}
