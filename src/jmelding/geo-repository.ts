import type { Database } from "@/db/client";
import { type SQL, sql } from "drizzle-orm";

export type GeoBbox = [number, number, number, number];

export type GeoListRow = {
  jmNumber: string;
  fragmentKey: string;
  fragmentId: string | null;
  title: string;
  status: string;
  region: string;
  category: string | null;
  url: string;
  hasGeo: boolean;
  bbox: GeoBbox | null;
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
  limit: number;
  cursor?: string | null;
};

export type NearParams = {
  lon: number;
  lat: number;
  radiusKm: number;
  region?: string;
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
    createdAt:
      typeof row.created_at === "string"
        ? row.created_at
        : row.created_at.toISOString(),
    updatedAt:
      typeof row.updated_at === "string"
        ? row.updated_at
        : row.updated_at.toISOString(),
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

export class JMeldingGeoRepository {
  constructor(private readonly db: Database) {}

  async findByJmNumber(key: string): Promise<GeoFullRecord | null> {
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
    return row ? toFullRecord(row) : null;
  }

  async list(params: ListParams): Promise<PageResult<GeoListRow>> {
    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const conditions: SQL[] = [];
    if (params.status) conditions.push(sql`status = ${params.status}`);
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
    return paginate(rows.map(toListRow), limit);
  }

  async findInBbox(params: BboxParams): Promise<PageResult<GeoListRow>> {
    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const conditions: SQL[] = [
      sql`geom IS NOT NULL`,
      sql`ST_Intersects(geom, ST_MakeEnvelope(${params.minLon}, ${params.minLat}, ${params.maxLon}, ${params.maxLat}, 4326))`,
    ];
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
    return paginate(rows.map(toListRow), limit);
  }

  async findNear(params: NearParams): Promise<PageResult<GeoListRow>> {
    const limit = clampLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const radiusMeters = Math.max(0, params.radiusKm) * 1000;
    const conditions: SQL[] = [
      sql`geom IS NOT NULL`,
      sql`ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${params.lon}, ${params.lat}), 4326)::geography, ${radiusMeters})`,
    ];
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
    return paginate(rows.map(toListRow), limit);
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
