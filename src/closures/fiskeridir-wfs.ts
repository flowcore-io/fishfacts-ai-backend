/**
 * Fiskeridirektoratet's current closure register, keyed by J-number and paragraph.
 * Full authority polygons preserve coastline details, holes and separate parts.
 * `geom_original` is supplementary register evidence and may contain points
 * absent from the printed law, including show:true points. It cannot establish
 * statutory vertices or substitute for parsing the actual legal text.
 * This service is not a historical archive; reviewed versions are frozen by
 * the regulation snapshot pipeline rather than read from this mutable source.
 */

const FISKERIDIR_CLOSURES_WFS =
  "https://gis.fiskeridir.no/server/rest/services/J_melding_stengt_wfs/MapServer/0/query";

const UA = "Mozilla/5.0 (compatible; FishFactsBot/1.0; +https://fishfacts.fo)";

export type OfficialVertex = { lat: number; lon: number };

export type OfficialClosure = {
  /** `jmelding_navn`, e.g. `J-153-2026`. */
  jmNumber: string;
  /** `paragraf` — the § the closure is defined in. */
  paragraph: number | null;
  name: string | null;
  /** Parsed `geom_original`, in the order the authority lists it. */
  vertices: OfficialVertex[];
  /** Entries of `geom_original` that did not parse, if any. */
  unreadableVertices: number;
};

type ArcGisFeature = {
  attributes: {
    jmelding_navn?: string | null;
    paragraf?: number | null;
    navn?: string | null;
    geom_original?: string | null;
  };
};

/**
 * Degrees and decimal minutes, in either of the two notations the register
 * actually uses:
 *
 *   `"70 45,000"`      → 70.75   (bare, comma decimal — the common form)
 *   `"010° 44.0000E"`  → 10.7333 (degree sign, hemisphere letter)
 *
 * Both appear inside `geom_original`, sometimes across paragraphs of the same
 * J-melding (J-146-2026 § 1 is the second form, § 2 the first).
 */
export function parseOfficialCoordinate(raw: string): number | null {
  const match =
    /^\s*(\d{1,3})\s*(?:°\s*)?(\d{1,3}(?:[.,]\d+)?)\s*(?:'\s*)?([NSEWVØ])?\s*$/i.exec(
      raw,
    );
  if (!match) return null;
  const degrees = Number(match[1]);
  const minutes = Number.parseFloat(match[2].replace(",", "."));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  if (minutes >= 60) return null;
  const hemisphere = match[3]?.toUpperCase();
  const sign =
    hemisphere === "S" || hemisphere === "W" || hemisphere === "V" ? -1 : 1;
  return sign * (degrees + minutes / 60);
}

export function parseOfficialVertices(raw: string | null | undefined): {
  vertices: OfficialVertex[];
  unreadable: number;
} {
  if (!raw) return { vertices: [], unreadable: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { vertices: [], unreadable: 0 };
  }
  if (!Array.isArray(parsed)) return { vertices: [], unreadable: 0 };
  const vertices: OfficialVertex[] = [];
  let unreadable = 0;
  for (const entry of parsed) {
    const lat =
      typeof entry?.lat === "string"
        ? parseOfficialCoordinate(entry.lat)
        : null;
    const lon =
      typeof entry?.lon === "string"
        ? parseOfficialCoordinate(entry.lon)
        : null;
    if (lat === null || lon === null) {
      unreadable++;
      continue;
    }
    vertices.push({ lat, lon });
  }
  return { vertices, unreadable };
}

export async function fetchFiskeridirClosures(
  signal?: AbortSignal,
): Promise<OfficialClosure[]> {
  const url = new URL(FISKERIDIR_CLOSURES_WFS);
  url.searchParams.set("where", "1=1");
  url.searchParams.set(
    "outFields",
    "jmelding_navn,paragraf,navn,geom_original",
  );
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  const response = await fetch(url, {
    headers: { "user-agent": UA },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Fiskeridirektoratet closure register returned ${response.status}`,
    );
  }
  const json = (await response.json()) as {
    features?: ArcGisFeature[];
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(
      `Fiskeridirektoratet closure register error: ${json.error.message ?? "unknown"}`,
    );
  }
  return (json.features ?? []).flatMap((feature) => {
    const jmNumber = feature.attributes.jmelding_navn?.trim();
    if (!jmNumber) return [];
    const { vertices, unreadable } = parseOfficialVertices(
      feature.attributes.geom_original,
    );
    return [
      {
        jmNumber,
        paragraph: feature.attributes.paragraf ?? null,
        name: feature.attributes.navn?.trim() ?? null,
        vertices,
        unreadableVertices: unreadable,
      },
    ];
  });
}

export type OfficialPolygon = {
  /** `jmelding_navn`, e.g. `J-153-2026`. */
  jmNumber: string;
  paragraph: number;
  name: string | null;
  /** GeoJSON, exactly as the register's server returned it. */
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  vertexCount: number;
  featureIds?: string[];
};

export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };
export type GeoJsonMultiPolygon = {
  type: "MultiPolygon";
  coordinates: number[][][][];
};

/** Norway, Svalbard and the surrounding seas with room to spare. A shape that
 * lands outside this is a broken response, not a closure. */
const NORDIC_BOX = { minLat: 45, maxLat: 90, minLon: -30, maxLon: 45 };

function ringsOf(geometry: GeoJsonPolygon | GeoJsonMultiPolygon): number[][][] {
  return geometry.type === "Polygon"
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

export function polygonVertexCount(
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon,
): number {
  return ringsOf(geometry).reduce((total, ring) => total + ring.length, 0);
}

/** True when every vertex is a finite [lon, lat] inside the Nordic box. */
export function polygonIsPlausible(
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon,
): boolean {
  const rings = ringsOf(geometry);
  if (rings.length === 0) return false;
  return rings.every(
    (ring) =>
      ring.length >= 4 &&
      ring.every(
        ([lon, lat]) =>
          Number.isFinite(lon) &&
          Number.isFinite(lat) &&
          lat >= NORDIC_BOX.minLat &&
          lat <= NORDIC_BOX.maxLat &&
          lon >= NORDIC_BOX.minLon &&
          lon <= NORDIC_BOX.maxLon,
      ),
  );
}

type GeoJsonFeature = {
  id?: string | number;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: {
    jmelding_navn?: string | null;
    paragraf?: number | null;
    navn?: string | null;
    iid?: number;
  } | null;
};

/**
 * The drawn shape of every closure in the register, as GeoJSON.
 *
 * Asks the server for `f=geojson` rather than converting Esri rings here:
 * telling an outer ring from an island hole is a winding-order judgement, and
 * the server already makes it. § 6 of the seinot forskrift comes back as ONE
 * polygon with 108 holes, not 109 patches — reading the rings ourselves is how
 * that gets wrong.
 *
 * A feature with no paragraph, no geometry, a geometry type that is not a
 * polygon, or vertices outside the Nordic box is skipped and reported by the
 * caller through the returned `skipped` count — never repaired.
 */
export async function fetchFiskeridirPolygons(
  signal?: AbortSignal,
): Promise<{ polygons: OfficialPolygon[]; skipped: number; merged: number }> {
  const idsUrl = new URL(FISKERIDIR_CLOSURES_WFS);
  idsUrl.searchParams.set("where", "1=1");
  idsUrl.searchParams.set("returnIdsOnly", "true");
  idsUrl.searchParams.set("f", "json");
  const idsResponse = await fetch(idsUrl, {
    headers: { "user-agent": UA },
    signal,
  });
  if (!idsResponse.ok)
    throw new Error(
      `Fiskeridirektoratet closure register returned ${idsResponse.status}`,
    );
  const idsJson = (await idsResponse.json()) as {
    objectIds?: number[];
    error?: { message?: string };
  };
  if (idsJson.error)
    throw new Error(
      `Fiskeridirektoratet closure register error: ${idsJson.error.message ?? "unknown"}`,
    );
  if (
    !Array.isArray(idsJson.objectIds) ||
    idsJson.objectIds.some((id) => !Number.isSafeInteger(id)) ||
    new Set(idsJson.objectIds).size !== idsJson.objectIds.length
  )
    throw new Error("Fiskeridirektoratet feature inventory missing or invalid");
  const features: GeoJsonFeature[] = [];
  // Explicit object-id inventory avoids transfer-limit truncation and paging
  // shifts. Any disappeared/duplicate/new alien member refuses the observation.
  for (let i = 0; i < idsJson.objectIds.length; i += 100) {
    const ids = idsJson.objectIds.slice(i, i + 100);
    const url = new URL(FISKERIDIR_CLOSURES_WFS);
    url.searchParams.set("objectIds", ids.join(","));
    url.searchParams.set("outFields", "iid,jmelding_navn,paragraf,navn");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "geojson");
    const response = await fetch(url, {
      headers: { "user-agent": UA },
      signal,
    });
    if (!response.ok)
      throw new Error(
        `Fiskeridirektoratet closure register returned ${response.status}`,
      );
    const json = (await response.json()) as {
      features?: GeoJsonFeature[];
      exceededTransferLimit?: boolean;
      error?: { message?: string };
    };
    if (json.error)
      throw new Error(
        `Fiskeridirektoratet closure register error: ${json.error.message ?? "unknown"}`,
      );
    const returned =
      json.features?.map((f) => Number(f.properties?.iid ?? f.id)) ?? [];
    if (
      json.exceededTransferLimit ||
      returned.length !== ids.length ||
      new Set(returned).size !== ids.length ||
      returned.some((id) => !ids.includes(id))
    )
      throw new Error("Fiskeridirektoratet incomplete feature inventory");
    features.push(...(json.features ?? []));
  }
  const polygons: OfficialPolygon[] = [];
  let skipped = 0;
  for (const feature of features) {
    const jmNumber = feature.properties?.jmelding_navn?.trim();
    const paragraph = feature.properties?.paragraf;
    const geometry = feature.geometry;
    const isPolygon =
      geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
    if (
      !jmNumber ||
      typeof paragraph !== "number" ||
      !Number.isInteger(paragraph) ||
      paragraph < 1 ||
      !isPolygon
    ) {
      skipped++;
      continue;
    }
    const typed = geometry as GeoJsonPolygon | GeoJsonMultiPolygon;
    if (!polygonIsPlausible(typed)) {
      skipped++;
      continue;
    }
    polygons.push({
      jmNumber,
      paragraph,
      name: feature.properties?.navn?.trim() ?? null,
      geometry: typed,
      vertexCount: polygonVertexCount(typed),
      featureIds: [String(feature.properties?.iid ?? feature.id)],
    });
  }
  return { ...mergeRepeatedParagraphs(polygons), skipped };
}

/**
 * One shape per J-melding and §, whatever the register sends.
 *
 * Nothing in the register forbids two features under the same key — it has not
 * happened (65 features, 65 keys, checked 2026-09-30), but a § naming several
 * separate waters is exactly how it would. Keeping one would silently drop
 * geometry; keeping both would break the one-row-per-§ key the review screen
 * joins on. Their polygons are joined into a single `MultiPolygon` instead,
 * which loses no coordinate: each part keeps its own rings and holes.
 */
export function mergeRepeatedParagraphs(polygons: OfficialPolygon[]): {
  polygons: OfficialPolygon[];
  merged: number;
} {
  const groups = new Map<string, OfficialPolygon[]>();
  for (const polygon of polygons) {
    const key = `${polygon.jmNumber}:${polygon.paragraph}`;
    const group = groups.get(key);
    if (group) group.push(polygon);
    else groups.set(key, [polygon]);
  }
  let merged = 0;
  const result: OfficialPolygon[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    merged += group.length - 1;
    const parts = group.flatMap((polygon) =>
      polygon.geometry.type === "Polygon"
        ? [polygon.geometry.coordinates]
        : polygon.geometry.coordinates,
    );
    result.push({
      jmNumber: group[0].jmNumber,
      paragraph: group[0].paragraph,
      name: group.find((polygon) => polygon.name)?.name ?? null,
      geometry: { type: "MultiPolygon", coordinates: parts },
      vertexCount: group.reduce((total, p) => total + p.vertexCount, 0),
      featureIds: group.flatMap((p) => p.featureIds ?? []),
    });
  }
  return { polygons: result, merged };
}
