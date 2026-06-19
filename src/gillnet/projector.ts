import type { Database } from "@/db/client";
import {
  type GillnetVesselObserved,
  gillnetVesselObservedSchema,
} from "@/events/contracts";
import { sql } from "drizzle-orm";

type EventEnvelope = {
  eventId: string;
  payload: unknown;
};

/** MULTILINESTRING WKT from the vessel's nets (each net = one from→to line). */
function netsToWkt(item: GillnetVesselObserved): string | null {
  const lines = item.nets
    .map((n) => `(${n.from.lon} ${n.from.lat}, ${n.to.lon} ${n.to.lat})`)
    .filter(Boolean);
  return lines.length > 0 ? `MULTILINESTRING(${lines.join(", ")})` : null;
}

function bboxOf(
  item: GillnetVesselObserved,
): [number, number, number, number] | null {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const n of item.nets) {
    for (const p of [n.from, n.to]) {
      minLon = Math.min(minLon, p.lon);
      minLat = Math.min(minLat, p.lat);
      maxLon = Math.max(maxLon, p.lon);
      maxLat = Math.max(maxLat, p.lat);
    }
  }
  return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
}

export class GillnetProjector {
  constructor(private readonly db: Database) {}

  async handleObserved(event: EventEnvelope): Promise<void> {
    const item = gillnetVesselObservedSchema.parse(event.payload);
    if (item.nets.length === 0) return;

    const wkt = netsToWkt(item);
    const geomExpr = wkt
      ? sql`ST_GeomFromText(${wkt}, 4326)`
      : sql`NULL::geometry`;
    const bbox = bboxOf(item);
    const netsJson = JSON.stringify(item.nets);
    const lastUpdated = item.lastUpdatedAt ?? null;

    await this.db.execute(sql`
      INSERT INTO gillnet_positions (
        call_sign, vessel_name, gear_type, snapshot_date, last_updated_at,
        nets, geom, min_lat, max_lat, min_lon, max_lon, source_event_id, updated_at
      )
      VALUES (
        ${item.callSign}, ${item.vesselName}, ${item.gearType}, ${item.snapshotDate},
        ${lastUpdated}, ${netsJson}::jsonb, ${geomExpr},
        ${bbox?.[1] ?? null}, ${bbox?.[3] ?? null}, ${bbox?.[0] ?? null}, ${bbox?.[2] ?? null},
        ${event.eventId}, now()
      )
      ON CONFLICT (call_sign) DO UPDATE SET
        vessel_name     = EXCLUDED.vessel_name,
        gear_type       = EXCLUDED.gear_type,
        snapshot_date   = EXCLUDED.snapshot_date,
        last_updated_at = EXCLUDED.last_updated_at,
        nets            = EXCLUDED.nets,
        geom            = EXCLUDED.geom,
        min_lat         = EXCLUDED.min_lat,
        max_lat         = EXCLUDED.max_lat,
        min_lon         = EXCLUDED.min_lon,
        max_lon         = EXCLUDED.max_lon,
        source_event_id = EXCLUDED.source_event_id,
        updated_at      = now()
    `);
  }
}
