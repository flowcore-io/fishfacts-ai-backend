import type { Database } from "@/db/client";
import { sql } from "drizzle-orm";

export type GillnetNet = {
  idx: number;
  from: { lat: number; lon: number; area: string | null };
  to: { lat: number; lon: number; area: string | null };
};

export type GillnetVesselRow = {
  callSign: string;
  vesselName: string;
  gearType: string;
  snapshotDate: string;
  lastUpdatedAt: string | null;
  nets: GillnetNet[];
  bbox: [number, number, number, number] | null;
};

type DbRow = {
  call_sign: string;
  vessel_name: string;
  gear_type: string;
  snapshot_date: string;
  last_updated_at: Date | string | null;
  nets: unknown;
  min_lat: number | null;
  max_lat: number | null;
  min_lon: number | null;
  max_lon: number | null;
};

function toRow(r: DbRow): GillnetVesselRow {
  const bbox: GillnetVesselRow["bbox"] =
    r.min_lat !== null &&
    r.max_lat !== null &&
    r.min_lon !== null &&
    r.max_lon !== null
      ? [r.min_lon, r.min_lat, r.max_lon, r.max_lat]
      : null;
  return {
    callSign: r.call_sign,
    vesselName: r.vessel_name,
    gearType: r.gear_type,
    snapshotDate: r.snapshot_date,
    lastUpdatedAt:
      r.last_updated_at == null
        ? null
        : typeof r.last_updated_at === "string"
          ? r.last_updated_at
          : r.last_updated_at.toISOString(),
    nets: Array.isArray(r.nets) ? (r.nets as GillnetNet[]) : [],
    bbox,
  };
}

export type GillnetBbox = [number, number, number, number];

/**
 * Faroese gillnet positions read model. Returns only the LATEST daily snapshot
 * (the feed is a full replace), so vessels absent from today's feed are excluded.
 */
export class GillnetRepository {
  constructor(private readonly db: Database) {}

  async listLatest(params?: {
    bbox?: GillnetBbox;
  }): Promise<{ snapshotDate: string | null; vessels: GillnetVesselRow[] }> {
    const conditions = [
      sql`snapshot_date = (SELECT MAX(snapshot_date) FROM gillnet_positions)`,
    ];
    if (params?.bbox) {
      const [minLon, minLat, maxLon, maxLat] = params.bbox;
      conditions.push(
        sql`geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326))`,
      );
    }
    let where = conditions[0] as ReturnType<typeof sql>;
    for (let i = 1; i < conditions.length; i++) {
      where = sql`${where} AND ${conditions[i]}`;
    }
    const result = await this.db.execute<DbRow>(sql`
      SELECT call_sign, vessel_name, gear_type, snapshot_date, last_updated_at,
             nets, min_lat, max_lat, min_lon, max_lon
      FROM gillnet_positions
      WHERE ${where}
      ORDER BY vessel_name ASC
    `);
    const rows = Array.isArray(result)
      ? (result as DbRow[])
      : ((result as unknown as { rows?: DbRow[] }).rows ?? []);
    const vessels = rows.map(toRow);
    return { snapshotDate: vessels[0]?.snapshotDate ?? null, vessels };
  }
}
