/**
 * IHO-IOC GEBCO Gazetteer of Undersea Feature Names ingester. Pulls the named
 * undersea features (banks, ridges, basins, seamounts, …) from the public GEBCO
 * ArcGIS FeatureServer and normalises each into a `GebcoFeature` with WGS84 WKT
 * geometry, a centroid (for on-map labels), and a bbox.
 *
 * Pure fetch+parse (no DB/event deps) so it is unit/live testable in isolation.
 * Source: https://www.gebco.net/data-products/undersea-feature-names
 */

const SERVICE_URL =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Undersea_Features/FeatureServer";
const UA = "Mozilla/5.0 (compatible; FishFactsBot/1.0; +https://fishfacts.fo)";
const PAGE_SIZE = 2000;

export type GebcoGeometryKind = "point" | "line" | "polygon";

export type GebcoFeature = {
  featureId: string;
  name: string;
  featureType: string;
  geometryType: GebcoGeometryKind;
  geomWkt: string;
  centroidLat: number;
  centroidLon: number;
  bbox: [number, number, number, number];
};

type ArcgisLayer = { id: number; name: string; geometryType: string };
type ArcgisFeature = {
  attributes: Record<string, unknown>;
  geometry?: {
    points?: number[][];
    paths?: number[][][];
    rings?: number[][][];
    x?: number;
    y?: number;
  };
};

function kindForGeometryType(esri: string): GebcoGeometryKind | null {
  if (esri === "esriGeometryPoint" || esri === "esriGeometryMultipoint")
    return "point";
  if (esri === "esriGeometryPolyline") return "line";
  if (esri === "esriGeometryPolygon") return "polygon";
  return null;
}

function isFinitePair(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    typeof p[0] === "number" &&
    typeof p[1] === "number" &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  );
}

function fmt(p: [number, number]): string {
  return `${p[0]} ${p[1]}`;
}

/** Close an ArcGIS ring if the last vertex differs from the first. */
function closeRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 3) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
}

/**
 * Build WKT + centroid + bbox from one ArcGIS feature. Returns null when the
 * geometry is empty / degenerate for its kind.
 */
export function geometryToWkt(
  kind: GebcoGeometryKind,
  geom: ArcgisFeature["geometry"],
): {
  wkt: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
} | null {
  if (!geom) return null;
  const all: [number, number][] = [];
  let wkt: string | null = null;

  if (kind === "point") {
    let pts: [number, number][] = [];
    if (Array.isArray(geom.points)) {
      pts = geom.points.filter(isFinitePair) as [number, number][];
    } else if (
      typeof geom.x === "number" &&
      typeof geom.y === "number" &&
      Number.isFinite(geom.x) &&
      Number.isFinite(geom.y)
    ) {
      pts = [[geom.x, geom.y]];
    }
    if (pts.length === 0) return null;
    all.push(...pts);
    wkt =
      pts.length === 1
        ? `POINT(${fmt(pts[0])})`
        : `MULTIPOINT(${pts.map((p) => `(${fmt(p)})`).join(", ")})`;
  } else if (kind === "line") {
    const paths = (geom.paths ?? [])
      .map((path) => path.filter(isFinitePair) as [number, number][])
      .filter((path) => path.length >= 2);
    if (paths.length === 0) return null;
    for (const path of paths) all.push(...path);
    wkt = `MULTILINESTRING(${paths
      .map((path) => `(${path.map(fmt).join(", ")})`)
      .join(", ")})`;
  } else {
    const rings = (geom.rings ?? [])
      .map((ring) => closeRing(ring.filter(isFinitePair) as [number, number][]))
      .filter((ring) => ring.length >= 4);
    if (rings.length === 0) return null;
    for (const ring of rings) all.push(...ring);
    // Each ArcGIS ring becomes its own polygon part — exact outer/hole topology
    // is not needed for bbox/label/intersection use.
    wkt = `MULTIPOLYGON(${rings
      .map((ring) => `((${ring.map(fmt).join(", ")}))`)
      .join(", ")})`;
  }

  if (!wkt || all.length === 0) return null;
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of all) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
    sumLon += lon;
    sumLat += lat;
  }
  return {
    wkt,
    centroid: [sumLon / all.length, sumLat / all.length],
    bbox: [minLon, minLat, maxLon, maxLat],
  };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`GEBCO ArcGIS HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Discover the FeatureServer's layer ids + geometry types. */
export async function fetchGebcoLayers(
  signal?: AbortSignal,
): Promise<ArcgisLayer[]> {
  const meta = (await fetchJson(`${SERVICE_URL}?f=json`, signal)) as {
    layers?: Array<{ id: number; name: string; geometryType?: string }>;
  };
  const layers = Array.isArray(meta.layers) ? meta.layers : [];
  return layers
    .map((l) => ({
      id: l.id,
      name: l.name,
      geometryType: l.geometryType ?? "",
    }))
    .filter((l) => kindForGeometryType(l.geometryType) !== null);
}

function attr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Fetch + normalise every undersea feature across all FeatureServer layers. */
export async function fetchGebcoFeatures(
  signal?: AbortSignal,
): Promise<GebcoFeature[]> {
  const layers = await fetchGebcoLayers(signal);
  const out: GebcoFeature[] = [];
  const seen = new Set<string>();

  for (const layer of layers) {
    const kind = kindForGeometryType(layer.geometryType);
    if (!kind) continue;
    let offset = 0;
    for (;;) {
      const query = new URLSearchParams({
        where: "1=1",
        outFields: "NAME,TYPE,FEATURE_ID",
        returnGeometry: "true",
        outSR: "4326",
        f: "json",
        resultOffset: String(offset),
        resultRecordCount: String(PAGE_SIZE),
      });
      const url = `${SERVICE_URL}/${layer.id}/query?${query.toString()}`;
      const page = (await fetchJson(url, signal)) as {
        features?: ArcgisFeature[];
        exceededTransferLimit?: boolean;
      };
      const features = Array.isArray(page.features) ? page.features : [];
      for (const f of features) {
        const featureId =
          attr(f.attributes, "FEATURE_ID") ?? attr(f.attributes, "OBJECTID");
        const name = attr(f.attributes, "NAME");
        const featureType = attr(f.attributes, "TYPE") ?? "Feature";
        if (!featureId || !name) continue;
        if (seen.has(featureId)) continue;
        const built = geometryToWkt(kind, f.geometry);
        if (!built) continue;
        seen.add(featureId);
        out.push({
          featureId,
          name,
          featureType,
          geometryType: kind,
          geomWkt: built.wkt,
          centroidLon: built.centroid[0],
          centroidLat: built.centroid[1],
          bbox: built.bbox,
        });
      }
      if (!page.exceededTransferLimit || features.length === 0) break;
      offset += features.length;
    }
  }
  return out;
}
