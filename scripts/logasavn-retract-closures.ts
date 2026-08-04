/**
 * Take every Lógasavn-derived closure off the map.
 *
 * One row is live as this is written: `LOG-K-35-2026` (Føroyabanki), drawn on
 * 2026-08-03 from `Kunngerð 35/2026` and labelled
 * `lógasavn friðing (statutory closure)`. Its ten vertices are right — verified
 * digit-for-digit — and the LABEL is wrong: `§ 2` defines an area and
 * `§§ 3–15` impose a permit- and fishing-day regime over it, which is not a
 * closure. Two independent readings said so. Føroyabanki is also governed by
 * three in-force instruments and we drew one, so what a skipper sees is not
 * merely mislabelled, it is partial.
 *
 * A wrong shape on a fisherman's chart is worse than no shape, so it comes off
 * now and goes back when something that can read the statutes puts it back.
 *
 * **Emitted as events, not deleted from `jmelding_geo`.** The read model is a
 * projection: an announcement with `status: "archived"` and no areas clears the
 * geometry through the same path that drew it, and survives a replay. Deleting
 * the rows would look identical today and quietly redraw the closure the next
 * time the pathway is replayed.
 *
 *   bun scripts/logasavn-retract-closures.ts          # dry run (lists rows)
 *   bun scripts/logasavn-retract-closures.ts --apply  # emit the retractions
 *
 * Safe to re-run: rows already `archived` are skipped, so a second run emits
 * nothing rather than re-archiving everything with a fresh event each time.
 */
import { createDb } from "../src/db/client";
import { loadEnv } from "../src/env";
import { JMeldingGeoProjector } from "../src/jmelding/geo-projector";
import { JMeldingChunkAssembler } from "../src/jobs/jmelding-chunk-assembler";
import { JMeldingFragmentProjector } from "../src/jobs/jmelding-fragments";
import { createPathwayRuntime } from "../src/pathways";
import { UsableApiClient } from "../src/usable/client";

/** Every `jmelding_geo` row this service drew from Lógasavn carries it. */
const LOGASAVN_KEY_PREFIX = "LOG";

const APPLY = process.argv.includes("--apply");
const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

type Row = { jm_number: string; title: string; url: string; status: string };

/**
 * The pump is never started here, so no registered handler can fire and the
 * projectors below exist only to satisfy the constructor. The chunk assembler
 * is built for real anyway — it is cheap, and a stub that silently became live
 * would drop announcements rather than fail loudly.
 */
function runtimeForWritingOnly() {
  const usable = new UsableApiClient(env);
  const chunkAssembler = new JMeldingChunkAssembler(
    db,
    new JMeldingFragmentProjector(env, usable),
    new JMeldingGeoProjector(db),
  );
  const unusedProjector = new Proxy(
    {},
    {
      get() {
        throw new Error(
          "a projector ran in a write-only script — the pump was started by mistake",
        );
      },
    },
  ) as never;
  return createPathwayRuntime(
    env,
    {
      async upsertFromEvent() {},
      async findById() {
        return null;
      },
    } as never,
    chunkAssembler,
    unusedProjector,
    unusedProjector,
    unusedProjector,
    unusedProjector,
    unusedProjector,
    unusedProjector,
  );
}

try {
  const rows = (await client`
    SELECT jm_number, title, url, status
    FROM jmelding_geo
    WHERE jm_number LIKE ${`${LOGASAVN_KEY_PREFIX}-%`}
      AND status <> 'archived'
    ORDER BY jm_number
  `) as unknown as Row[];

  console.log(
    `[RetractLogasavn] ${rows.length} Lógasavn row(s) currently drawn:`,
  );
  for (const row of rows) {
    console.log(`  ${row.jm_number}  ${row.status}  ${row.title}`);
  }

  if (rows.length === 0) {
    console.log("[RetractLogasavn] nothing to retract");
  } else if (!APPLY) {
    console.log("[RetractLogasavn] dry run — pass --apply to emit");
  } else {
    const checkedAt = new Date().toISOString();
    const { writer } = runtimeForWritingOnly();
    for (const row of rows) {
      await writer.writeJMeldingAnnouncement({
        // Timestamped so this retraction is its own event rather than a
        // duplicate signature the pathway would deduplicate away.
        signature: `${row.jm_number}:retracted:${checkedAt}`,
        title: row.title,
        url: row.url,
        status: "archived",
        jmNumber: row.jm_number,
        region: "FO",
        // No `areas`: the projector writes the empty geometry back over the
        // row, which is the point — an archived row that keeps its polygon is
        // still a polygon on somebody's map.
        bodyMarkdown: "",
        checkedAt,
      });
      console.log(`[RetractLogasavn] retracted ${row.jm_number}`);
    }
    console.log(`[RetractLogasavn] emitted ${rows.length} retraction(s)`);
  }
} finally {
  await client.end();
}
