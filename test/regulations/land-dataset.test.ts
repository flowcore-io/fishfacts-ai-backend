import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { canonicalDigest } from "../../src/events/json-digest";
import {
  importLandDataset,
  verifyLandManifest,
} from "../../src/regulations/land-dataset";
const { db, client } = createDb(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
);
let directory: string;
const owned: string[] = [];
beforeAll(async () => {
  await runMigrations(db, client);
  directory = await mkdtemp(join(tmpdir(), "ff-land-test-"));
});
afterAll(async () => {
  for (const id of owned) {
    await client`DELETE FROM regulation_land_features WHERE dataset_id=${id}`;
    await client`DELETE FROM regulation_land_datasets WHERE id=${id}`;
  }
  await client.end();
  await rm(directory, { recursive: true, force: true });
});
async function artifact(outside = false) {
  const [row] =
    await client`SELECT encode(ST_AsBinary(ST_GeomFromText(${outside ? "POLYGON((12 12,13 12,13 13,12 13,12 12))" : "POLYGON((1 1,2 1,2 2,1 2,1 1))"},4326),'NDR'),'hex') wkb`;
  const data = `${JSON.stringify({ sourceFid: 7, wkbHex: row.wkb })}\n`;
  const file = join(directory, randomUUID());
  await Bun.write(file, data);
  const content = {
    version: 1,
    archiveSha256: "a".repeat(64),
    extractSha256: createHash("sha256").update(data).digest("hex"),
    extractBytes: Buffer.byteLength(data),
    features: 1,
    coordinates: 5,
    coverage: {
      type: "Polygon",
      coordinates: [
        [
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
          [10, 0],
        ],
      ],
    },
    crs: "EPSG:4326",
    dataDate: "2026-10-01T00:00:00Z",
    sourceUrl: "https://example.test/synthetic-reference.zip",
    sourceReadme: "Synthetic test reference, not OSM data",
    license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    copyrightUrl: "https://www.openstreetmap.org/copyright",
    tools: {
      python: "test",
      geopandas: "test",
      pyogrio: "test",
      gdal: "test",
      shapely: "test",
      geos: "test",
      pyproj: "test",
    },
    preparationScriptSha256: "b".repeat(64),
    preparation: "synthetic test",
    command: "synthetic test",
  };
  const manifest = {
    ...content,
    datasetId: `osm-land-v1-${canonicalDigest(content)}`,
  };
  owned.push(manifest.datasetId);
  return { manifest, file };
}
test("identity binds full manifest/coverage; exact atomic import and existing verification reject actual row corruption", async () => {
  const { manifest, file } = await artifact();
  expect(verifyLandManifest(manifest).datasetId).toBe(manifest.datasetId);
  expect(() =>
    verifyLandManifest({
      ...manifest,
      coverage: {
        ...manifest.coverage,
        coordinates: [
          [
            [11, 0],
            [11, 10],
            [0, 10],
            [0, 0],
            [11, 0],
          ],
        ],
      },
    }),
  ).toThrow("identity");
  expect((await importLandDataset(client, manifest, file)).status).toBe(
    "imported",
  );
  expect((await importLandDataset(client, manifest, file)).status).toBe(
    "verified_existing",
  );
  await client`UPDATE regulation_land_features SET geom=ST_Translate(geom,0.1,0) WHERE dataset_id=${manifest.datasetId}`;
  await expect(importLandDataset(client, manifest, file)).rejects.toThrow(
    "mismatch",
  );
}, 5000);
test("missing/checksum/actual uncovered geometry refuse; rollback cannot publish a partial dataset", async () => {
  const { manifest, file } = await artifact(true);
  await expect(importLandDataset(client, manifest, file)).rejects.toThrow(
    "coverage/bytes mismatch",
  );
  expect(
    (
      await client`SELECT id FROM regulation_land_datasets WHERE id=${manifest.datasetId}`
    ).length,
  ).toBe(0);
  await Bun.write(file, "altered");
  await expect(importLandDataset(client, manifest, file)).rejects.toThrow(
    "checksum",
  );
  await expect(
    importLandDataset(client, manifest, join(directory, "missing")),
  ).rejects.toThrow();
}, 5000);
