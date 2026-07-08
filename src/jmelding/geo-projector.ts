import type { Database } from "@/db/client";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import { jmeldingFragmentKey } from "@/jobs/jmelding-fragments";
import { sql } from "drizzle-orm";
import {
  areasToFeatureCollection,
  areasToWkt,
  parseJmeldingGeo,
} from "./geo-parser";
import { normalizeVornAreas } from "./vorn-ring";

export type GeoProjectionResult = {
  jmNumber: string;
  fragmentKey: string;
  hasGeo: boolean;
  skipped: boolean;
};

/** [minLon, minLat, maxLon, maxLat] for pre-parsed (FO/IS) geometry. */
function bboxFromAreas(
  areas: NonNullable<JMeldingAnnouncementDiscovered["areas"]>,
): [number, number, number, number] | null {
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const a of areas) {
    for (const p of a.points) {
      minLat = Math.min(minLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLat = Math.max(maxLat, p.lat);
      maxLon = Math.max(maxLon, p.lon);
    }
  }
  return Number.isFinite(minLat) ? [minLon, minLat, maxLon, maxLat] : null;
}

export class JMeldingGeoProjector {
  constructor(private readonly db: Database) {}

  async project(
    item: JMeldingAnnouncementDiscovered,
    fragmentId: string | null,
  ): Promise<GeoProjectionResult> {
    const fragmentKey = jmeldingFragmentKey(item.url, {
      region: item.region,
      jmNumber: item.jmNumber,
    });
    const jmNumber = item.jmNumber ?? fragmentKey;

    if (!item.jmNumber && item.status === "unknown") {
      return { jmNumber, fragmentKey, hasGeo: false, skipped: true };
    }

    // FO/IS collectors supply pre-parsed geometry; Norwegian announcements
    // parse coords out of the body via the existing parser.
    let areas = item.areas;
    // Faroese (Vørn) rings are hand-transcribed point lists that close by
    // repeating the first vertex — the raw event keeps them verbatim (incl.
    // typos), so clean them here in the read-model transformer: drop the
    // closing dup and repair a typo'd/self-intersecting ring. A warning means a
    // source typo we should report to Vørn (monitored in Groundcover).
    if (areas && areas.length > 0 && item.region === "FO") {
      const normalized = normalizeVornAreas(areas);
      areas = normalized.areas;
      for (const w of normalized.warnings) {
        console.warn(
          `[Vorn] closure geometry normalized: ${jmNumber} — ${w.message}`,
          { jmNumber, url: item.url, ...w },
        );
      }
    }
    const parsed =
      areas && areas.length > 0
        ? {
            areas,
            bbox: bboxFromAreas(areas),
            hasGeo: areas.some((a) => a.points.length > 0),
          }
        : parseJmeldingGeo(item.bodyMarkdown);
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
        jm_number, fragment_key, fragment_id, title, status, region, category, url, signature,
        has_geo, areas, geojson, geom, min_lat, max_lat, min_lon, max_lon, updated_at
      )
      VALUES (
        ${jmNumber}, ${fragmentKey}, ${fragmentId}, ${item.title}, ${item.status}, ${item.region ?? "NO"}, ${item.category ?? null}, ${item.url}, ${item.signature},
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
        region       = EXCLUDED.region,
        category     = EXCLUDED.category,
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
