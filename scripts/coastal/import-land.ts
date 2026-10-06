import postgres from "postgres";
import { importLandDataset } from "../../src/regulations/land-dataset";
const args = process.argv.slice(2);
if (args.length !== 2 || !process.env.COASTAL_REFERENCE_DATABASE_URL) {
  console.error(
    "Usage: COASTAL_REFERENCE_DATABASE_URL=<explicit LOCAL/operator database URL> bun --no-env-file scripts/coastal/import-land.ts <manifest.json> <land.ndjson>\nReference-only atomic import; schema migrations must already be installed. No download, domain mutation or production default. Keep original archive/extract/manifest outside git and retain exact versions. Preparation: uv run --python 3.14.4 scripts/coastal/prepare-land.py --help",
  );
  process.exit(2);
}
const sql = postgres(process.env.COASTAL_REFERENCE_DATABASE_URL, { max: 1 });
try {
  console.log(
    await importLandDataset(sql, await Bun.file(args[0]).json(), args[1]),
  );
} finally {
  await sql.end();
}
