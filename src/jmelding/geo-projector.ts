import type { Database } from "@/db/client";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import { jmeldingFragmentKey } from "@/jobs/jmelding-fragments";
import { sql } from "drizzle-orm";
import {
  areasToFeatureCollection,
  areasToWkt,
  parseJmeldingGeo,
} from "./geo-parser";
import { parseValidityEnd, parseValidityStart } from "./validity";
import { normalizeVornAreas } from "./vorn-ring";

export type GeoProjectionResult = {
  jmNumber: string;
  fragmentKey: string;
  hasGeo: boolean;
  skipped: boolean;
};

/** [minLon, minLat, maxLon, maxLat] for pre-parsed (FO/IS) geometry. */
export function bboxFromAreas(
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
    // Scoped to VORN's rings, not all Faroese ones. This repairs typo'd and
    // self-intersecting rings, which is right for hand-transcribed ban pages and
    // wrong for statute geometry: Lógasavn rings come from a parser that fails
    // closed, so a "repair" here could silently move a vertex — the one failure
    // class (parsed successfully to the WRONG value) that nothing downstream can
    // detect. `sourceFragmentId` marks the statute-derived events.
    if (
      areas &&
      areas.length > 0 &&
      item.region === "FO" &&
      !item.sourceFragmentId
    ) {
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

    // Each region publishes its window in its own shape; normalise to instants
    // so `status = "current"` can be re-checked against the clock on read.
    const validFrom = parseValidityStart(item.validFrom) ?? null;
    const validTo = parseValidityEnd(item.validTo) ?? null;

    const areasJson = JSON.stringify(parsed.areas);
    const geojsonJson = geojson === null ? null : JSON.stringify(geojson);
    const geomExpr = wkt
      ? sql`ST_GeomFromText(${wkt}, 4326)`
      : sql`NULL::geometry`;

    await this.db.execute(sql`
      INSERT INTO jmelding_geo (
        jm_number, fragment_key, fragment_id, title, status, region, category, url, signature, content_hash,
        valid_from, valid_to,
        has_geo, areas, geojson, geom, min_lat, max_lat, min_lon, max_lon, updated_at
      )
      VALUES (
        ${jmNumber}, ${fragmentKey}, ${fragmentId}, ${item.title}, ${item.status}, ${item.region ?? "NO"}, ${item.category ?? null}, ${item.url}, ${item.signature}, ${item.contentHash ?? null},
        ${validFrom}::timestamptz, ${validTo}::timestamptz,
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
        content_hash = EXCLUDED.content_hash,
        valid_from   = EXCLUDED.valid_from,
        valid_to     = EXCLUDED.valid_to,
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
