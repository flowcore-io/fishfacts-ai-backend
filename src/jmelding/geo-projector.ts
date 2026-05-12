import type { Database } from "@/db/client";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import { jmeldingFragmentKey } from "@/jobs/jmelding-fragments";
import { sql } from "drizzle-orm";
import {
  areasToFeatureCollection,
  areasToWkt,
  parseJmeldingGeo,
} from "./geo-parser";

export type GeoProjectionResult = {
  jmNumber: string;
  fragmentKey: string;
  hasGeo: boolean;
  skipped: boolean;
};

export class JMeldingGeoProjector {
  constructor(private readonly db: Database) {}

  async project(
    item: JMeldingAnnouncementDiscovered,
    fragmentId: string | null,
  ): Promise<GeoProjectionResult> {
    const fragmentKey = jmeldingFragmentKey(item.url);
    const jmNumber = item.jmNumber ?? fragmentKey;

    if (!item.jmNumber && item.status === "unknown") {
      return { jmNumber, fragmentKey, hasGeo: false, skipped: true };
    }

    const parsed = parseJmeldingGeo(item.bodyMarkdown);
    const geojson = areasToFeatureCollection(parsed.areas);
    const wkt = areasToWkt(parsed.areas);
    const bbox = parsed.bbox;

    const areasJson = JSON.stringify(parsed.areas);
    const geojsonJson = geojson === null ? null : JSON.stringify(geojson);
    const geomExpr = wkt
      ? sql`ST_GeomFromText(${wkt}, 4326)`
      : sql`NULL::geometry`;

    await this.db.execute(sql`
      INSERT INTO jmelding_geo (
        jm_number, fragment_key, fragment_id, title, status, url, signature,
        has_geo, areas, geojson, geom, min_lat, max_lat, min_lon, max_lon, updated_at
      )
      VALUES (
        ${jmNumber}, ${fragmentKey}, ${fragmentId}, ${item.title}, ${item.status}, ${item.url}, ${item.signature},
        ${parsed.hasGeo}, ${areasJson}::jsonb, ${geojsonJson}::jsonb,
        ${geomExpr},
        ${bbox?.[1] ?? null}, ${bbox?.[3] ?? null}, ${bbox?.[0] ?? null}, ${bbox?.[2] ?? null},
        now()
      )
      ON CONFLICT (jm_number) DO UPDATE SET
        fragment_key = EXCLUDED.fragment_key,
        fragment_id  = EXCLUDED.fragment_id,
        title        = EXCLUDED.title,
        status       = EXCLUDED.status,
        url          = EXCLUDED.url,
        signature    = EXCLUDED.signature,
        has_geo      = EXCLUDED.has_geo,
        areas        = EXCLUDED.areas,
        geojson      = EXCLUDED.geojson,
        geom         = EXCLUDED.geom,
        min_lat      = EXCLUDED.min_lat,
        max_lat      = EXCLUDED.max_lat,
        min_lon      = EXCLUDED.min_lon,
        max_lon      = EXCLUDED.max_lon,
        updated_at   = now()
    `);

    return {
      jmNumber,
      fragmentKey,
      hasGeo: parsed.hasGeo,
      skipped: false,
    };
  }
}
