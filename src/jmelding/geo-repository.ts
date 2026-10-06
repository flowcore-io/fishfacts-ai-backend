import { type Database, timestampToIso } from "@/db/client";
import * as schema from "@/db/schema";
import type { sourceSignatureOf } from "@/regulations/coastal-state";
import { caseIdFor } from "@/regulations/ids";
import { pinnedSnapshotManifests } from "@/regulations/official-vector";
import { type SQL, and, eq, inArray, sql } from "drizzle-orm";

export type GeoBbox = [number, number, number, number];
export type PublishedGeometryMarker = {
  caseId: string;
  publishedRevisionId: string;
  snapshotManifestHash?: string | null;
  geometryVersion: 2;
  geometryModelVersion: 0 | 1;
  metadataOnly: boolean;
  liveSourceSignature: ReturnType<typeof sourceSignatureOf>;
};

export type GeoListRow = {
  jmNumber: string;
  fragmentKey: string;
  fragmentId: string | null;
  title: string;
  status: string;
  region: string;
  category: string | null;
  url: string;
  /** Validity window as published by the source; null where none was given. */
  validFrom: string | null;
  validTo: string | null;
  hasGeo: boolean;
  bbox: GeoBbox | null;
  publishedGeometry?: PublishedGeometryMarker;
  drawable?: false;
};

export type GeoFullRecord = GeoListRow & {
  signature: string;
  areas: unknown;
  geojson: unknown;
  createdAt: string;
  updatedAt: string;
};

export type ListParams = {
  status?: string;
  region?: string;
  hasGeo?: boolean;
  q?: string;
  limit: number;
  cursor?: string | null;
};

export type BboxParams = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  region?: string;
  status?: string;
  limit: number;
  cursor?: string | null;
};

export type NearParams = {
  lon: number;
  lat: number;
  radiusKm: number;
  region?: string;
  status?: string;
  limit: number;
  cursor?: string | null;
};

export type PageResult<T> = {
  rows: T[];
  nextCursor: string | null;
};

const SELECT_LIST_COLUMNS = sql`
  jm_number,
  fragment_key,
  fragment_id,
  title,
  status,
  region,
  category,
  url,
  valid_from,
  valid_to,
  has_geo,
  min_lat,
  max_lat,
  min_lon,
  max_lon
`;

const SELECT_FULL_COLUMNS = sql`
  jm_number,
  fragment_key,
  fragment_id,
  title,
  status,
  region,
  category,
  url,
  signature,
  valid_from,
  valid_to,
  has_geo,
  areas,
  ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
  geojson,
  min_lat,
  max_lat,
  min_lon,
  max_lon,
  created_at,
  updated_at
`;

type ListDbRow = {
  jm_number: string;
  fragment_key: string;
  fragment_id: string | null;
  title: string;
  status: string;
  region: string;
  category: string | null;
  url: string;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  has_geo: boolean;
  min_lat: number | null;
  max_lat: number | null;
  min_lon: number | null;
  max_lon: number | null;
};

type FullDbRow = ListDbRow & {
  signature: string;
  areas: unknown;
  geom_geojson: unknown;
  geojson: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

function encodeCursor(jmNumber: string): string {
  return Buffer.from(jmNumber, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** Row timestamps as ISO, `null` where the column is empty. */
function toIso(value: Date | string | null | undefined): string | null {
  return timestampToIso(value) ?? null;
}

function toListRow(row: ListDbRow): GeoListRow {
  const bbox: GeoBbox | null =
    row.min_lat !== null &&
    row.max_lat !== null &&
    row.min_lon !== null &&
    row.max_lon !== null
      ? [row.min_lon, row.min_lat, row.max_lon, row.max_lat]
      : null;
  return {
    jmNumber: row.jm_number,
    fragmentKey: row.fragment_key,
    fragmentId: row.fragment_id,
    title: row.title,
    status: row.status,
    region: row.region,
    category: row.category,
    url: row.url,
    validFrom: toIso(row.valid_from),
    validTo: toIso(row.valid_to),
    hasGeo: row.has_geo,
    bbox,
  };
}

function toFullRecord(row: FullDbRow): GeoFullRecord {
  const base = toListRow(row);
  return {
    ...base,
    signature: row.signature,
    areas: row.areas,
    geojson: row.geojson ?? row.geom_geojson ?? null,
    // NOT NULL in `jmeldingGeo`, so the non-nullable overload applies and
    // these are `string`. Routed through the shared normaliser like their
    // neighbours: the inline version returned Postgres' rendering verbatim, so
    // one record could carry an ISO `validFrom` beside a non-ISO `createdAt`.
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
  };
}

function paginate<T extends { jmNumber: string }>(
  rows: T[],
  limit: number,
): PageResult<T> {
  if (rows.length > limit) {
    const trimmed = rows.slice(0, limit);
    const last = trimmed[trimmed.length - 1];
    return {
      rows: trimmed,
      nextCursor: last ? encodeCursor(last.jmNumber) : null,
    };
  }
  return { rows, nextCursor: null };
}

/**
 * Filter for a requested `status`. Asking for `current` is a question about
 * right now, so it is answered against the clock and not only against the
 * word a scraper stored: a row also has to be inside its published validity
 * window. That is what keeps a notice that expired in 2011 — or an Icelandic
 * skyndilokun whose two weeks are up — out of the answer without anything
 * having to rewrite the stored row first.
 *
 * A row with no window (Norwegian notices scraped before `valid_to` was
 * captured, open-ended regulations) is left in: absence of a date is not
 * evidence of expiry. Run `scripts/jmelding-backfill-validity.ts` to fill the
 * dates in for rows already stored.
 *
 * `current`, `archived` and `upcoming` are meant to cover the corpus between
 * them, so no row is unreachable from every filter.
 */
function statusConditions(status: string): SQL[] {
  if (status === "current") {
    return [
      sql`status = ${status}`,
      sql`(valid_to IS NULL OR valid_to >= now())`,
      sql`(valid_from IS NULL OR valid_from <= now())`,
    ];
  }
  if (status === "archived") {
    // The complement of in-force, not a second literal match on the word. A
    // notice that expired while still stored as `current` — every row the
    // backfill has not reached yet — would otherwise be returned by neither
    // filter, so "which regulations have expired" would come back short.
    return [sql`(status = ${status} OR valid_to < now())`];
  }
  if (status === "upcoming") {
    // Adopted, not yet in force ("Kommende"): live and not superseded, so it
    // is stored as current, and `current` deliberately excludes it. This is
    // the query that reaches it.
    return [sql`status = 'current'`, sql`valid_from > now()`];
  }
  return [sql`status = ${status}`];
}

export class JMeldingGeoRepository {
  constructor(private readonly db: Database) {}

  async findByJmNumber(
    key: string,
    evidenceOnly = false,
  ): Promise<GeoFullRecord | null> {
    const lookup = key.trim();
    if (!lookup) return null;
    const result = await this.db.execute<FullDbRow>(sql`
      SELECT ${SELECT_FULL_COLUMNS}
      FROM jmelding_geo
      WHERE jm_number = ${lookup} OR fragment_key = ${lookup}
      LIMIT 1
    `);
    const row =
      (result as unknown as { rows?: FullDbRow[] }).rows?.[0] ??
      (Array.isArray(result)
        ? (result[0] as FullDbRow | undefined)
        : undefined);
    return row ? (await this.gate([toFullRecord(row)], evidenceOnly))[0] : null;
  }

  async list(params: ListParams): Promise<PageResult<GeoListRow>> {
    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const conditions: SQL[] = [];
    if (params.status) conditions.push(...statusConditions(params.status));
    if (params.region) conditions.push(sql`region = ${params.region}`);
    if (typeof params.hasGeo === "boolean")
      conditions.push(sql`has_geo = ${params.hasGeo}`);
    if (params.q)
      conditions.push(sql`jm_number ILIKE ${`${params.q.toLowerCase()}%`}`);
    if (cursor) conditions.push(sql`jm_number < ${cursor}`);
    const where = whereClause(conditions);
    const rows = await this.execListQuery(sql`
      SELECT ${SELECT_LIST_COLUMNS}
      FROM jmelding_geo
      ${where}
      ORDER BY jm_number DESC
      LIMIT ${limit + 1}
    `);
    return paginate(await this.gate(rows.map(toListRow)), limit);
  }

  /**
   * Rows WITH geometry inline (areas), for bulk-drawing a whole set in one call
   * (e.g. "show all Icelandic closures") instead of one get_regulation per area.
   * Optional region + bbox filter; only geometry-bearing rows; capped.
   */
  /**
   * Everything the caller needs to DRAW a regulation and say what it is.
   *
   * `url` and `summary` are here because the drawing path is the only one most
   * users ever hit, and without them a drawn shape can only be described as
   * `title - category (status)` — no source to check, no statement of what the
   * regulation actually does. A skipper who cannot tell what a shape means, or
   * follow it back to the text, cannot report it as wrong either, and reports
   * are the whole feedback loop for this data.
   */
  async listForDrawing(params: {
    region?: string;
    bbox?: GeoBbox;
    status?: string;
    limit?: number;
    evidenceOnly?: boolean;
  }): Promise<
    Array<{
      jmNumber: string;
      title: string;
      status: string;
      region: string;
      category: string | null;
      url: string;
      summary: string | null;
      validFrom: string | null;
      validTo: string | null;
      areas: unknown;
    }>
  > {
    const cap = Math.min(Math.max(params.limit ?? 500, 1), 1000);
    const conditions: SQL[] = [sql`geom IS NOT NULL`];
    conditions.push(...statusConditions(params.status ?? "current"));
    if (params.region) conditions.push(sql`region = ${params.region}`);
    if (params.bbox) {
      const [minLon, minLat, maxLon, maxLat] = params.bbox;
      conditions.push(
        sql`ST_Intersects(geom, ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326))`,
      );
    }
    const result = await this.db.execute<{
      jm_number: string;
      title: string;
      status: string;
      region: string;
      category: string | null;
      url: string;
      summary: string | null;
      valid_from: Date | string | null;
      valid_to: Date | string | null;
      areas: unknown;
    }>(sql`
      SELECT jm_number, title, status, region, category, url, summary, valid_from, valid_to, areas
      FROM jmelding_geo
      ${whereClause(conditions)}
      ORDER BY jm_number DESC
      LIMIT ${cap}
    `);
    const rows = Array.isArray(result)
      ? result
      : ((result as unknown as { rows?: unknown[] }).rows ?? []);
    return this.gate(
      (rows as Array<Record<string, unknown>>).map((r) => ({
        jmNumber: r.jm_number as string,
        title: r.title as string,
        status: r.status as string,
        region: r.region as string,
        category: (r.category as string | null) ?? null,
        url: (r.url as string) ?? "",
        summary: (r.summary as string | null) ?? null,
        validFrom: toIso((r.valid_from as Date | string | null) ?? null),
        validTo: toIso((r.valid_to as Date | string | null) ?? null),
        areas: r.areas,
      })),
      params.evidenceOnly,
    );
  }

  async findInBbox(params: BboxParams): Promise<PageResult<GeoListRow>> {
    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const conditions: SQL[] = [
      sql`geom IS NOT NULL`,
      sql`ST_Intersects(geom, ST_MakeEnvelope(${params.minLon}, ${params.minLat}, ${params.maxLon}, ${params.maxLat}, 4326))`,
    ];
    if (params.status) conditions.push(...statusConditions(params.status));
    if (params.region) conditions.push(sql`region = ${params.region}`);
    if (cursor) conditions.push(sql`jm_number < ${cursor}`);
    const where = whereClause(conditions);
    const rows = await this.execListQuery(sql`
      SELECT ${SELECT_LIST_COLUMNS}
      FROM jmelding_geo
      ${where}
      ORDER BY jm_number DESC
      LIMIT ${limit + 1}
    `);
    return paginate(await this.gate(rows.map(toListRow)), limit);
  }

  async findNear(params: NearParams): Promise<PageResult<GeoListRow>> {
    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const radiusMeters = Math.max(0, params.radiusKm) * 1000;
    const conditions: SQL[] = [
      sql`geom IS NOT NULL`,
      sql`ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${params.lon}, ${params.lat}), 4326)::geography, ${radiusMeters})`,
    ];
    if (params.status) conditions.push(...statusConditions(params.status));
    if (params.region) conditions.push(sql`region = ${params.region}`);
    if (cursor) conditions.push(sql`jm_number < ${cursor}`);
    const where = whereClause(conditions);
    const rows = await this.execListQuery(sql`
      SELECT ${SELECT_LIST_COLUMNS}
      FROM jmelding_geo
      ${where}
      ORDER BY jm_number DESC
      LIMIT ${limit + 1}
    `);
    return paginate(await this.gate(rows.map(toListRow)), limit);
  }

  /** Exact authoritative source identity gates every old drawable surface.
   * This never consults a current-only/paginated published list. */
  private async gate<T extends { jmNumber: string; region: string }>(
    rows: T[],
    evidenceOnly = false,
  ): Promise<T[]> {
    const refs = rows.filter((r) => r.region === "NO").map((r) => r.jmNumber);
    if (!refs.length) return rows;
    const pins = await this.db
      .select({
        caseId: schema.regulationCases.id,
        sourceRef: schema.regulationCases.sourceRef,
        caseKey: schema.regulationCases.caseKey,
        publishedRevisionId: schema.regulationCases.publishedRevisionId,
        metadataOnly: schema.regulationCases.publishedMetadataOnly,
        model: schema.regulationCaseRevisions.geometryModelVersion,
        unpublishedOfficial: sql<boolean>`${schema.regulationCases.publishedRevisionId} is null and exists (select 1 from regulation_case_geometries g where g.case_id = ${schema.regulationCases.id} and g.revision_id = ${schema.regulationCases.currentRevisionId} and g.geometry_source = 'official-vector')`,
        liveSourceSignature: schema.jmeldingGeo.liveSourceSignature,
      })
      .from(schema.regulationCases)
      .leftJoin(
        schema.regulationCaseRevisions,
        and(
          eq(
            schema.regulationCaseRevisions.id,
            schema.regulationCases.publishedRevisionId,
          ),
          eq(schema.regulationCaseRevisions.caseId, schema.regulationCases.id),
        ),
      )
      .leftJoin(
        schema.jmeldingGeo,
        eq(schema.jmeldingGeo.jmNumber, schema.regulationCases.sourceRef),
      )
      .where(
        and(
          eq(schema.regulationCases.sourceType, "fiskeridir-jmelding"),
          inArray(schema.regulationCases.sourceRef, refs),
        ),
      );
    const manifests = await pinnedSnapshotManifests(
      this.db,
      pins.flatMap((p) =>
        p.publishedRevisionId ? [p.publishedRevisionId] : [],
      ),
    );
    const byRef = new Map(
      pins
        .filter(
          (p) =>
            p.caseKey === `fiskeridir-jmelding:${p.sourceRef}` &&
            p.caseId === caseIdFor(p.caseKey) &&
            (p.unpublishedOfficial ||
              (p.publishedRevisionId &&
                (p.model === 1 ||
                  p.metadataOnly ||
                  manifests.has(p.publishedRevisionId)))),
        )
        .map((p) => [p.sourceRef, p]),
    );
    return rows.map((row) => {
      const pin = row.region === "NO" ? byRef.get(row.jmNumber) : undefined;
      if (!pin) return row;
      const publishedGeometry: PublishedGeometryMarker | undefined =
        pin.publishedRevisionId
          ? {
              caseId: pin.caseId,
              publishedRevisionId: pin.publishedRevisionId as string,
              ...(manifests.has(pin.publishedRevisionId as string)
                ? {
                    snapshotManifestHash: manifests.get(
                      pin.publishedRevisionId as string,
                    ),
                  }
                : {}),
              geometryVersion: 2,
              geometryModelVersion: pin.model === 1 ? 1 : 0,
              metadataOnly: pin.metadataOnly,
              liveSourceSignature:
                pin.liveSourceSignature as PublishedGeometryMarker["liveSourceSignature"],
            }
          : undefined;
      return {
        ...row,
        ...(publishedGeometry ? { publishedGeometry } : {}),
        ...(evidenceOnly
          ? { drawable: false as const }
          : { hasGeo: false, areas: [], geojson: null }),
      };
    });
  }

  private async execListQuery(query: SQL): Promise<ListDbRow[]> {
    const result = await this.db.execute<ListDbRow>(query);
    if (Array.isArray(result)) return result as ListDbRow[];
    const wrapped = result as unknown as { rows?: ListDbRow[] };
    return wrapped.rows ?? [];
  }
}

function whereClause(conditions: SQL[]): SQL {
  if (conditions.length === 0) return sql``;
  let combined: SQL = conditions[0] as SQL;
  for (let i = 1; i < conditions.length; i++) {
    combined = sql`${combined} AND ${conditions[i]}`;
  }
  return sql`WHERE ${combined}`;
}
