import type { Database } from "@/db/client";
import { sql } from "drizzle-orm";
import { getTileLayer } from "./catalog";

type MvtRow = { mvt: Uint8Array | null };

export class UnknownTileLayerError extends Error {
  constructor(public readonly layerId: string) {
    super(`unknown tile layer: ${layerId}`);
  }
}

export class TilesRepository {
  constructor(private readonly db: Database) {}

  async getTile(
    layerId: string,
    z: number,
    x: number,
    y: number,
  ): Promise<Uint8Array> {
    const layer = getTileLayer(layerId);
    if (!layer) throw new UnknownTileLayerError(layerId);
    switch (layer.id) {
      case "jmelding-closures":
        return this.jmeldingClosuresTile(z, x, y);
      default:
        throw new UnknownTileLayerError(layerId);
    }
  }

  private async jmeldingClosuresTile(
    z: number,
    x: number,
    y: number,
  ): Promise<Uint8Array> {
    const result = await this.db.execute<MvtRow>(sql`
      WITH env AS (
        SELECT ST_TileEnvelope(${z}, ${x}, ${y}) AS bbox_3857
      ),
      candidates AS (
        SELECT
          j.jm_number,
          j.title,
          j.status,
          ST_SetSRID(
            ST_GeomFromGeoJSON((jsonb_array_elements(j.geojson->'features')->'geometry')::text),
            4326
          ) AS pts
        FROM jmelding_geo j, env
        WHERE j.has_geo = true
          AND j.geom IS NOT NULL
          AND j.geom && ST_Transform(env.bbox_3857, 4326)
      ),
      hulls AS (
        SELECT
          c.jm_number,
          c.title,
          c.status,
          ST_ConvexHull(c.pts) AS poly
        FROM candidates c
      ),
      tiled AS (
        SELECT
          h.jm_number,
          h.title,
          h.status,
          ST_AsMVTGeom(
            ST_Transform(h.poly, 3857),
            env.bbox_3857,
            4096, 64, true
          ) AS geom
        FROM hulls h, env
        WHERE GeometryType(h.poly) IN ('POLYGON', 'MULTIPOLYGON')
      )
      SELECT ST_AsMVT(t.*, 'jmelding-closures', 4096, 'geom') AS mvt
      FROM (
        SELECT jm_number, title, status, geom
        FROM tiled
        WHERE geom IS NOT NULL
      ) t
    `);
    const row =
      (result as unknown as { rows?: MvtRow[] }).rows?.[0] ??
      (Array.isArray(result) ? (result[0] as MvtRow | undefined) : undefined);
    return row?.mvt ?? new Uint8Array();
  }
}
