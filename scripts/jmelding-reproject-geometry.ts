/**
 * Re-derive `jmelding_geo` geometry for rows that were projected before the
 * current transformer rules existed.
 *
 * The Vørn ring repair (`src/jmelding/vorn-ring.ts`) runs in the projector, so
 * a Faroese closure projected before it landed still carries the raw ring —
 * veiðibann nr. 14/2026 among them, whose typo'd closing vertex ("6014 N" for
 * "6104 N") leaves it ~93 km too far south and self-intersecting. Replaying
 * the pathway would fix it; so does this, without re-emitting a single event:
 * the raw points are still in the row's own `areas` column, so the projector
 * is simply run over them again.
 *
 * Safe to re-run — `normalizeVornRing` is deliberately conservative and leaves
 * an already-repaired ring (and a valid concave one, e.g. nr. 12) untouched.
 *
 *   bun scripts/jmelding-reproject-geometry.ts          # dry run (bbox diffs)
 *   bun scripts/jmelding-reproject-geometry.ts --apply  # write
 *   bun scripts/jmelding-reproject-geometry.ts --region IS --apply
 */
import { createDb } from "../src/db/client";
import type { JMeldingAnnouncementDiscovered } from "../src/events/contracts";
import {
  JMeldingGeoProjector,
  bboxFromAreas,
} from "../src/jmelding/geo-projector";
import { normalizeVornAreas } from "../src/jmelding/vorn-ring";

const APPLY = process.argv.includes("--apply");
const regionFlag = process.argv.indexOf("--region");
const REGION = (
  regionFlag === -1 ? "FO" : (process.argv[regionFlag + 1] ?? "FO")
).toUpperCase();
if (!["NO", "FO", "IS"].includes(REGION)) {
  // Catches `--region --apply`, which would otherwise select region "--APPLY"
  // and report a reassuring "0 rows".
  throw new Error(`--region must be one of NO, FO, IS (got "${REGION}")`);
}
const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend";

type Row = {
  jm_number: string;
  fragment_id: string | null;
  title: string;
  status: JMeldingAnnouncementDiscovered["status"];
  region: "NO" | "FO" | "IS";
  category: string | null;
  url: string;
  signature: string;
  valid_from: Date | null;
  valid_to: Date | null;
  areas: Array<{
    name: string | null;
    points: Array<{ lat: number; lon: number }>;
  }>;
  min_lat: number | null;
  max_lat: number | null;
  min_lon: number | null;
  max_lon: number | null;
};

function storedBbox(row: Row) {
  return row.min_lon === null ||
    row.min_lat === null ||
    row.max_lon === null ||
    row.max_lat === null
    ? null
    : ([row.min_lon, row.min_lat, row.max_lon, row.max_lat] as const);
}

/** The areas as the projector would store them today. */
function normalized(row: Row) {
  return REGION === "FO" ? normalizeVornAreas(row.areas).areas : row.areas;
}

/** The row, back in the shape the projector consumes. */
function toAnnouncement(row: Row): JMeldingAnnouncementDiscovered {
  return {
    signature: row.signature,
    title: row.title,
    url: row.url,
    status: row.status,
    region: row.region,
    jmNumber: row.jm_number,
    category: row.category ?? undefined,
    validFrom: row.valid_from?.toISOString(),
    validTo: row.valid_to?.toISOString(),
    areas: row.areas,
    // Only read when `areas` is empty, which is never true for the rows this
    // script selects.
    bodyMarkdown: "",
    checkedAt: new Date().toISOString(),
  };
}

const { db, client } = createDb(url);
try {
  const rows = (await client`
    SELECT jm_number, fragment_id, title, status, region, category, url, signature,
           valid_from, valid_to, areas, min_lat, max_lat, min_lon, max_lon
    FROM jmelding_geo
    WHERE region = ${REGION}
      AND jsonb_typeof(areas) = 'array'
      AND areas <> '[]'::jsonb
  `) as unknown as Row[];

  // Compare the points, not only the extent: dropping the closing duplicate —
  // or a typo'd vertex that sits inside the hull — rewrites the geometry
  // without moving the bbox, and those rows need reprojecting just as much.
  const changed = rows.filter((row) => {
    const after = normalized(row);
    return (
      JSON.stringify(after) !== JSON.stringify(row.areas) ||
      JSON.stringify(bboxFromAreas(after)) !== JSON.stringify(storedBbox(row))
    );
  });

  console.log(
    `[ReprojectGeometry] ${REGION}: ${rows.length} rows with geometry, ${changed.length} to reproject`,
  );
  for (const row of changed) {
    const before = JSON.stringify(storedBbox(row));
    const after = JSON.stringify(bboxFromAreas(normalized(row)));
    console.log(
      `  ${row.jm_number}: ${
        before === after
          ? `bbox unchanged ${after}, points rewritten`
          : `${before} → ${after}`
      }`,
    );
  }

  if (!APPLY) {
    console.log("[ReprojectGeometry] dry run — pass --apply to write");
  } else {
    // Exactly the rows the dry run listed — an untouched row should not get a
    // fresh `updated_at` from a maintenance script.
    const projector = new JMeldingGeoProjector(db);
    for (const row of changed) {
      await projector.project(toAnnouncement(row), row.fragment_id);
    }
    console.log(`[ReprojectGeometry] reprojected ${changed.length} rows`);
  }
} finally {
  await client.end();
}
