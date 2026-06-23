import type { Database } from "@/db/client";
import {
  type GebcoFeatureObserved,
  gebcoFeatureObservedSchema,
} from "@/events/contracts";
import { sql } from "drizzle-orm";

type EventEnvelope = {
  eventId: string;
  payload: unknown;
};

/**
 * Projects `gebco.feature.observed.0` events into the `gebco_features` read
 * model. Upserts by the stable `feature_id` (no snapshot full-replace — the
 * gazetteer is append-mostly). Idempotent: replaying the stream rebuilds the
 * table.
 */
export class GebcoProjector {
  constructor(private readonly db: Database) {}

  async handleObserved(event: EventEnvelope): Promise<void> {
    const item: GebcoFeatureObserved = gebcoFeatureObservedSchema.parse(
      event.payload,
    );
    const [minLon, minLat, maxLon, maxLat] = item.bbox;

    await this.db.execute(sql`
      INSERT INTO gebco_features (
        feature_id, name, feature_type, geometry_type, geom,
        centroid_lat, centroid_lon, min_lat, max_lat, min_lon, max_lon,
        source_event_id, updated_at
      )
      VALUES (
        ${item.featureId}, ${item.name}, ${item.featureType}, ${item.geometryType},
        ST_GeomFromText(${item.geomWkt}, 4326),
        ${item.centroidLat}, ${item.centroidLon},
        ${minLat}, ${maxLat}, ${minLon}, ${maxLon},
        ${event.eventId}, now()
      )
      ON CONFLICT (feature_id) DO UPDATE SET
        name            = EXCLUDED.name,
        feature_type    = EXCLUDED.feature_type,
        geometry_type   = EXCLUDED.geometry_type,
        geom            = EXCLUDED.geom,
        centroid_lat    = EXCLUDED.centroid_lat,
        centroid_lon    = EXCLUDED.centroid_lon,
        min_lat         = EXCLUDED.min_lat,
        max_lat         = EXCLUDED.max_lat,
        min_lon         = EXCLUDED.min_lon,
        max_lon         = EXCLUDED.max_lon,
        source_event_id = EXCLUDED.source_event_id,
        updated_at      = now()
    `);
  }
}
