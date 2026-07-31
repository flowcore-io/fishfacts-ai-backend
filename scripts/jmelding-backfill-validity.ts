/**
 * Backfill `jmelding_geo.valid_from` / `valid_to` (and correct `status`) for
 * rows that were projected before the validity window was captured.
 *
 * The Norwegian rows can be repaired in place, without a re-scrape: the stored
 * `title` is the whole listing row as Fiskeridir renders it —
 *
 *   "J-114-2023 Forskrift om forbud mot å fiske reker i NAFO-området i 2023
 *    Gyldig fra og med 07.07.2023 Utløpsdato 31.12.2023 Utgått"
 *
 * — so the window and the notice's own status word are already sitting in the
 * database. That is what fixes the ~1,296 long-expired notices that
 * `/api/jmeldinger?region=NO&status=current` was returning.
 *
 * Faroese and Icelandic rows carry no dates in their titles (Vørn states the
 * window in the page prose, Fiskistofa in a WFS attribute) and `jmelding_geo`
 * keeps no body text to re-derive one from, so this script reports them as
 * un-derivable and cannot repair them. They need a **forced** re-scrape —
 * forced, because neither collector revisits what it has already seen:
 *
 *   POST /api/jobs/run  { "jobId": "vorn-veidibann",          "args": { "refreshExisting": true } }
 *   POST /api/jobs/run  { "jobId": "fiskistofa-wfs-closures", "args": { "refreshExisting": true } }
 *
 * Vørn skips every URL whose fragment key already exists unless
 * `refreshExisting` is set. Fiskistofa re-emits its whole result set, but only
 * for features still present in the `virkar_*` layers — a closure that has
 * already dropped out of a layer is reached by neither route and keeps
 * `valid_to = NULL`, which by design keeps it in `?status=current`. Sweep any
 * of those by hand.
 *
 *   bun scripts/jmelding-backfill-validity.ts          # dry run (counts + sample)
 *   bun scripts/jmelding-backfill-validity.ts --apply  # write
 */
import { createDb } from "../src/db/client";
import {
  parseValidityEnd,
  parseValidityStart,
  withExpiry,
} from "../src/jmelding/validity";
import {
  detectStatus,
  extractValidity,
} from "../src/jobs/fiskeridir-jmeldinger";

const APPLY = process.argv.includes("--apply");
const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend";

type Row = {
  jm_number: string;
  title: string;
  status: string;
  region: string;
};

/** What the stored title says about this notice, in instants. */
function derive(row: Row) {
  const validity = extractValidity(row.title);
  const validFrom = parseValidityStart(validity.validFrom) ?? null;
  const validTo = parseValidityEnd(validity.validTo) ?? null;
  const status = withExpiry(detectStatus(row.title, row.status), validTo);
  return { validFrom, validTo, status };
}

const { client } = createDb(url);
try {
  const rows = (await client`
    SELECT jm_number, title, status, region
    FROM jmelding_geo
    WHERE valid_to IS NULL AND valid_from IS NULL
  `) as unknown as Row[];

  const derivable = rows
    .map((row) => ({ row, derived: derive(row) }))
    .filter(
      ({ row, derived }) =>
        derived.validFrom !== null ||
        derived.validTo !== null ||
        derived.status !== row.status,
    );

  const byRegion = new Map<string, number>();
  for (const row of rows) {
    byRegion.set(row.region, (byRegion.get(row.region) ?? 0) + 1);
  }
  const reclassified = derivable.filter(
    ({ row, derived }) => derived.status !== row.status,
  );

  console.log(
    `[BackfillValidity] ${rows.length} rows without a stored window (${[
      ...byRegion,
    ]
      .map(([region, count]) => `${region}: ${count}`)
      .join(", ")})`,
  );
  console.log(
    `[BackfillValidity] ${derivable.length} derivable from the title, ${reclassified.length} of them also change status`,
  );
  for (const { row, derived } of reclassified.slice(0, 5)) {
    console.log(
      `  ${row.jm_number}: ${row.status} → ${derived.status} (valid_to ${derived.validTo ?? "—"})`,
    );
  }

  if (!APPLY) {
    console.log("[BackfillValidity] dry run — pass --apply to write");
  } else {
    for (const { row, derived } of derivable) {
      await client`
        UPDATE jmelding_geo
        SET valid_from = ${derived.validFrom}::timestamptz,
            valid_to   = ${derived.validTo}::timestamptz,
            status     = ${derived.status},
            updated_at = now()
        WHERE jm_number = ${row.jm_number}
      `;
    }
    console.log(`[BackfillValidity] updated ${derivable.length} rows`);
  }
} finally {
  await client.end();
}
