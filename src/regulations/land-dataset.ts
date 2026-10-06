import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { canonicalDigest, canonicalJson } from "@/events/json-digest";
import type postgres from "postgres";
import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const landManifestSchema = z
  .object({
    version: z.literal(1),
    datasetId: z.string(),
    archiveSha256: hash,
    extractSha256: hash,
    extractBytes: z.number().int().positive(),
    features: z.number().int().positive(),
    coordinates: z.number().int().positive(),
    coverage: z
      .object({
        type: z.literal("Polygon"),
        coordinates: z
          .array(z.array(z.tuple([z.number().finite(), z.number().finite()])))
          .length(1),
      })
      .strict(),
    crs: z.literal("EPSG:4326"),
    dataDate: z.string().datetime(),
    sourceUrl: z.string().url(),
    sourceReadme: z.string().min(1),
    license: z.literal("ODbL-1.0"),
    attribution: z.literal("© OpenStreetMap contributors"),
    copyrightUrl: z.literal("https://www.openstreetmap.org/copyright"),
    tools: z
      .object({
        python: z.string(),
        geopandas: z.string(),
        pyogrio: z.string(),
        gdal: z.string(),
        shapely: z.string(),
        geos: z.string(),
        pyproj: z.string(),
      })
      .strict(),
    preparationScriptSha256: hash,
    preparation: z.string().min(1),
    command: z.string().min(1),
  })
  .strict();
export type LandManifest = z.infer<typeof landManifestSchema>;
export function verifyLandManifest(input: unknown): LandManifest {
  const manifest = landManifestSchema.parse(input);
  const { datasetId, ...content } = manifest;
  if (datasetId !== `osm-land-v1-${canonicalDigest(content)}`)
    throw Error("land dataset identity mismatch");
  const ring = manifest.coverage.coordinates[0];
  // The reproducible preparation tool emits this exact rectangle orientation.
  if (ring.length !== 5)
    throw Error("land coverage must be an exact rectangle");
  const [[e, s], [e2, n], [w, n2], [w2, s2], [e3, s3]] = ring;
  if (
    !(
      e === e2 &&
      e === e3 &&
      w === w2 &&
      s === s2 &&
      s === s3 &&
      n === n2 &&
      w < e &&
      s < n &&
      w >= -180 &&
      e <= 180 &&
      s >= -90 &&
      n <= 90
    )
  )
    throw Error("invalid land coverage rectangle");
  return manifest;
}
export async function hashFile(path: string) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: digest.digest("hex"), bytes };
}
const rowSchema = z
  .object({
    sourceFid: z.number().int().nonnegative(),
    wkbHex: z
      .string()
      .min(2)
      .regex(/^[a-f0-9]+$/)
      .refine((s) => s.length % 2 === 0),
  })
  .strict();
/** Operator-only reference import. One transaction publishes a verified version;
 * does not write domain revisions, events, approvals or publication state. */
export async function importLandDataset(
  sql: postgres.Sql,
  input: unknown,
  extractPath: string,
) {
  const m = verifyLandManifest(input);
  const actual = await hashFile(extractPath);
  if (actual.sha256 !== m.extractSha256 || actual.bytes !== m.extractBytes)
    throw Error("land extract checksum/length mismatch");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`land-dataset:${m.datasetId}`},0))`;
    const known =
      await tx`SELECT manifest FROM regulation_land_datasets WHERE id=${m.datasetId}`;
    if (known.length && canonicalJson(known[0].manifest) !== canonicalJson(m))
      throw Error("same dataset ID has conflicting manifest");
    if (known.length) {
      // Do not trust a matching row count: verify every actual feature against bytes.
      await verifyRows(tx, m, extractPath);
      return { datasetId: m.datasetId, status: "verified_existing" };
    }
    await tx`INSERT INTO regulation_land_datasets (id,manifest,coverage) VALUES (${m.datasetId},${JSON.stringify(m)}::text::jsonb,ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(m.coverage)}),4326))`;
    const lines = createInterface({
      input: createReadStream(extractPath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let batch: Array<{
      dataset_id: string;
      source_fid: number;
      wkb_hex: string;
    }> = [];
    const flush = async () => {
      if (!batch.length) return;
      await tx`INSERT INTO regulation_land_features(dataset_id,source_fid,wkb_hex,geom) SELECT dataset_id,source_fid,wkb_hex,ST_SetSRID(ST_GeomFromWKB(decode(wkb_hex,'hex')),4326) FROM jsonb_to_recordset(${JSON.stringify(batch)}::text::jsonb) AS r(dataset_id text,source_fid bigint,wkb_hex text)`;
      batch = [];
    };
    for await (const line of lines) {
      const row = rowSchema.parse(JSON.parse(line));
      batch.push({
        dataset_id: m.datasetId,
        source_fid: row.sourceFid,
        wkb_hex: row.wkbHex,
      });
      if (batch.length >= 256) await flush();
    }
    await flush();
    await verifyRows(tx, m, extractPath);
    return { datasetId: m.datasetId, status: "imported" };
  });
}
async function verifyRows(
  tx: postgres.TransactionSql,
  m: LandManifest,
  extractPath: string,
) {
  const summary =
    await tx`SELECT count(*)::int count,coalesce(sum(ST_NPoints(geom)),0)::bigint coordinates,bool_and(ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND ST_GeometryType(geom) IN ('ST_Polygon','ST_MultiPolygon') AND ST_CoveredBy(geom,(SELECT coverage FROM regulation_land_datasets WHERE id=${m.datasetId})) AND encode(ST_AsBinary(geom,'NDR'),'hex')=wkb_hex) valid FROM regulation_land_features WHERE dataset_id=${m.datasetId}`;
  if (
    summary[0].count !== m.features ||
    Number(summary[0].coordinates) !== m.coordinates ||
    summary[0].valid !== true
  )
    throw Error("land actual rows/topology/coverage/bytes mismatch");
  const streamedHash = createHash("sha256");
  let streamedBytes = 0;
  let count = 0;
  let previous = -1;
  let batch: Array<{ source_fid: number; wkb_hex: string }> = [];
  const flush = async () => {
    if (!batch.length) return;
    const result =
      await tx`SELECT count(*)::int count FROM jsonb_to_recordset(${JSON.stringify(batch)}::text::jsonb) AS r(source_fid bigint,wkb_hex text) JOIN regulation_land_features f ON f.dataset_id=${m.datasetId} AND f.source_fid=r.source_fid AND f.wkb_hex=r.wkb_hex AND encode(ST_AsBinary(f.geom,'NDR'),'hex')=r.wkb_hex`;
    if (result[0].count !== batch.length)
      throw Error("land stored feature differs from exact artifact");
    batch = [];
  };
  for await (const line of createInterface({
    input: createReadStream(extractPath),
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    const bytes = Buffer.from(`${line}\n`, "utf8");
    streamedHash.update(bytes);
    streamedBytes += bytes.length;
    const row = rowSchema.parse(JSON.parse(line));
    if (row.sourceFid <= previous)
      throw Error("land source FIDs not uniquely ordered");
    previous = row.sourceFid;
    count++;
    batch.push({ source_fid: row.sourceFid, wkb_hex: row.wkbHex });
    if (batch.length >= 256) await flush();
  }
  await flush();
  if (count !== m.features) throw Error("land feature count mismatch");
  if (
    streamedHash.digest("hex") !== m.extractSha256 ||
    streamedBytes !== m.extractBytes
  )
    throw Error("land streamed bytes do not match immutable manifest");
}
