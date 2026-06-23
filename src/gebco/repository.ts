import type { Database } from "@/db/client";
import { sql } from "drizzle-orm";

export type GebcoFeatureRow = {
  featureId: string;
  name: string;
  featureType: string;
  geometryType: string;
  lat: number | null;
  lng: number | null;
  bbox: [number, number, number, number] | null;
  geojson?: unknown;
};

type DbRow = {
  feature_id: string;
  name: string;
  feature_type: string;
  geometry_type: string;
  centroid_lat: number | null;
  centroid_lon: number | null;
  min_lat: number | null;
  max_lat: number | null;
  min_lon: number | null;
  max_lon: number | null;
  geom_geojson?: unknown;
};

function toRow(r: DbRow): GebcoFeatureRow {
  const bbox: GebcoFeatureRow["bbox"] =
    r.min_lat !== null &&
    r.max_lat !== null &&
    r.min_lon !== null &&
    r.max_lon !== null
      ? [r.min_lon, r.min_lat, r.max_lon, r.max_lat]
      : null;
  const row: GebcoFeatureRow = {
    featureId: r.feature_id,
    name: r.name,
    featureType: r.feature_type,
    geometryType: r.geometry_type,
    lat: r.centroid_lat,
    lng: r.centroid_lon,
    bbox,
  };
  if (r.geom_geojson !== undefined) row.geojson = r.geom_geojson ?? null;
  return row;
}

export type GebcoBbox = [number, number, number, number];

function clampLimit(limit: number | undefined, fallback: number, max: number) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

/**
 * GEBCO undersea-feature read model. Lookups by name (for "where is Faroe
 * Bank"), by bbox (label every feature in the current map view), and by
 * point-radius. Geometry is returned as GeoJSON only when explicitly requested
 * — list/label callers just need the centroid.
 */
export class GebcoRepository {
  constructor(private readonly db: Database) {}

  private async exec(
    query: ReturnType<typeof sql>,
  ): Promise<GebcoFeatureRow[]> {
    const result = await this.db.execute<DbRow>(query);
    const rows = Array.isArray(result)
      ? (result as DbRow[])
      : ((result as unknown as { rows?: DbRow[] }).rows ?? []);
    return rows.map(toRow);
  }

  /** Name search — exact, then prefix, then substring; points before areas. */
  async findByName(
    q: string,
    limit?: number,
    includeGeoJSON = false,
  ): Promise<GebcoFeatureRow[]> {
    const needle = q.trim().toLowerCase();
    const like = `%${needle}%`;
    const prefix = `${needle}%`;
    const cap = clampLimit(limit, 20, 100);
    const geojsonSel = includeGeoJSON
      ? sql`, ST_AsGeoJSON(geom)::jsonb AS geom_geojson`
      : sql``;
    return this.exec(sql`
      SELECT feature_id, name, feature_type, geometry_type,
             centroid_lat, centroid_lon, min_lat, max_lat, min_lon, max_lon${geojsonSel}
      FROM gebco_features
      WHERE lower(name) LIKE ${like}
         OR lower(name || ' ' || feature_type) LIKE ${like}
      ORDER BY
        CASE
          WHEN lower(name) = ${needle}
            OR lower(name || ' ' || feature_type) = ${needle} THEN 0
          WHEN lower(name) LIKE ${prefix} THEN 1
          ELSE 2
        END,
        CASE WHEN geometry_type = 'point' THEN 0 ELSE 1 END,
        name ASC
      LIMIT ${cap}
    `);
  }

  async findById(
    featureId: string,
    includeGeoJSON = true,
  ): Promise<GebcoFeatureRow | null> {
    const geojsonSel = includeGeoJSON
      ? sql`, ST_AsGeoJSON(geom)::jsonb AS geom_geojson`
      : sql``;
    const rows = await this.exec(sql`
      SELECT feature_id, name, feature_type, geometry_type,
             centroid_lat, centroid_lon, min_lat, max_lat, min_lon, max_lon${geojsonSel}
      FROM gebco_features
      WHERE feature_id = ${featureId}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Every feature whose geometry intersects the bbox (labels for the view). */
  async findInBbox(
    bbox: GebcoBbox,
    limit?: number,
  ): Promise<GebcoFeatureRow[]> {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const cap = clampLimit(limit, 200, 1000);
    return this.exec(sql`
      SELECT feature_id, name, feature_type, geometry_type,
             centroid_lat, centroid_lon, min_lat, max_lat, min_lon, max_lon
      FROM gebco_features
      WHERE geom IS NOT NULL
        AND ST_Intersects(geom, ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326))
      ORDER BY name ASC
      LIMIT ${cap}
    `);
  }

  /** Features within `radiusKm` of a point. */
  async findNear(
    lon: number,
    lat: number,
    radiusKm: number,
    limit?: number,
  ): Promise<GebcoFeatureRow[]> {
    const radiusMeters = Math.max(0, radiusKm) * 1000;
    const cap = clampLimit(limit, 50, 200);
    return this.exec(sql`
      SELECT feature_id, name, feature_type, geometry_type,
             centroid_lat, centroid_lon, min_lat, max_lat, min_lon, max_lon
      FROM gebco_features
      WHERE geom IS NOT NULL
        AND ST_DWithin(
              geom::geography,
              ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
              ${radiusMeters}
            )
      ORDER BY
        geom::geography <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography ASC
      LIMIT ${cap}
    `);
  }
}
