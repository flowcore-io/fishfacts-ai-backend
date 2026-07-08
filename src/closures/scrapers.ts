/**
 * Region-aware closure scrapers for the Faroe Islands (Vørn) and Iceland
 * (Fiskistofa). Both produce a `ClosureRecord` compatible with the j-melding
 * geo pipeline (region + geometry), so closures land in the SAME geo store and
 * are returned by the shared `search_regulations`/`get_regulation` tools.
 *
 * Pure fetch+parse — no DB/event deps — so they are unit/live testable in
 * isolation. The collector jobs map `ClosureRecord` → the discovered event.
 */

export type ClosurePoint = { lat: number; lng: number };

export type ClosureRecord = {
  region: "FO" | "IS";
  source: "vorn" | "fiskistofa-wfs";
  sourceKey: string; // stable per-closure id (ban-nr-year / layer:featureId)
  title: string;
  status: "active" | "archived" | "unknown";
  closureType?: string;
  gear?: string;
  species?: string;
  legalBasis?: string;
  validFrom?: string;
  validTo?: string;
  url?: string;
  geometryType: "polygon" | "polyline" | "point" | "none";
  points: ClosurePoint[];
  bbox?: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  bodyMarkdown: string;
};

const UA = "Mozilla/5.0 (compatible; FishFactsBot/1.0; +https://fishfacts.fo)";

function bboxOf(points: ClosurePoint[]): ClosureRecord["bbox"] {
  if (points.length === 0) return undefined;
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minLng = Math.min(minLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLng = Math.max(maxLng, p.lng);
    maxLat = Math.max(maxLat, p.lat);
  }
  return [minLng, minLat, maxLng, maxLat];
}

function fmtPoint(p: ClosurePoint): string {
  const ns = p.lat >= 0 ? "N" : "S";
  const ew = p.lng >= 0 ? "E" : "W";
  return `${Math.abs(p.lat).toFixed(4)}${ns}, ${Math.abs(p.lng).toFixed(4)}${ew}`;
}

/**
 * Do any two non-adjacent edges of the ring cross? The ring is treated as
 * implicitly closed (last vertex → first vertex), matching how the map draws
 * it. Pure + allocation-light so it can gate the ring normaliser below.
 */
export function ringSelfIntersects(points: ClosurePoint[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  const ccw = (a: ClosurePoint, b: ClosurePoint, c: ClosurePoint) =>
    (c.lat - a.lat) * (b.lng - a.lng) > (b.lat - a.lat) * (c.lng - a.lng);
  const crosses = (
    a: ClosurePoint,
    b: ClosurePoint,
    c: ClosurePoint,
    d: ClosurePoint,
  ) => ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share a vertex — they can't "cross" meaningfully.
      if (j === (i + 1) % n || (j + 1) % n === i) continue;
      if (crosses(a, b, points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

export type RingNormalization = {
  code: "typo-unclosed-ring-repaired" | "unclosed-ring-unrepairable";
  message: string;
  droppedPoint?: ClosurePoint;
  firstPoint: ClosurePoint;
  lastPoint: ClosurePoint;
};

/**
 * Apply Vørn's ring-closing convention to a raw coordinate list.
 *
 * Every published ban closes its polygon by repeating the first vertex as the
 * last — we drop that duplicate (the common, non-warning path). When a ring
 * does NOT close that way *and* is self-intersecting, its final vertex is a
 * corrupted closing token: a coordinate typo in the source notice. Real case:
 * veiðibann nr. 14/2026, where the closing "6104 N – 0700 W" was fat-fingered
 * as "6014 N – 0700 W" (a digit transposition ~93 km too far south), leaving
 * the ring unclosed and self-crossing so it rendered as a degenerate shape.
 * Dropping that phantom vertex recovers the intended simple polygon; we return
 * a `warning` so the source typo can be flagged to Vørn.
 *
 * The repair is deliberately conservative: it fires only when the ring is
 * actually broken (self-intersecting) *and* dropping the offending vertex
 * demonstrably yields a simple polygon — a genuine non-repeating but valid ring
 * is never touched.
 */
export function normalizeVornRing(raw: ClosurePoint[]): {
  points: ClosurePoint[];
  warning: RingNormalization | null;
} {
  const points = [...raw];
  if (points.length <= 2) return { points, warning: null };
  const first = points[0];
  const last = points[points.length - 1];
  const closesByRepeat = first.lat === last.lat && first.lng === last.lng;
  if (closesByRepeat) {
    points.pop();
    return { points, warning: null };
  }
  // Unclosed ring — an anomaly, since every real Vørn ban closes by repeat.
  // Only intervene when the geometry is genuinely broken.
  if (!ringSelfIntersects(points)) return { points, warning: null };
  const repaired = points.slice(0, -1);
  if (repaired.length >= 3 && !ringSelfIntersects(repaired)) {
    return {
      points: repaired,
      warning: {
        code: "typo-unclosed-ring-repaired",
        message: `unclosed ring — final vertex ${fmtPoint(last)} does not repeat the first ${fmtPoint(first)} and the ring self-intersects; dropped it as a corrupted closing token (likely a coordinate typo in the source notice)`,
        droppedPoint: last,
        firstPoint: first,
        lastPoint: last,
      },
    };
  }
  return {
    points,
    warning: {
      code: "unclosed-ring-unrepairable",
      message: `self-intersecting ring that does not close on its first vertex ${fmtPoint(first)} (last ${fmtPoint(last)}); could not auto-repair — drawing as-is`,
      firstPoint: first,
      lastPoint: last,
    },
  };
}

// ---------------------------------------------------------------------------
// 🇫🇴 Vørn — bráðfeingis veiðibann (emergency trawl bans). Coords in raw HTML
// as DDMM, e.g. "6244 N – 0630 W" = 62°44′N 6°30′W.
// ---------------------------------------------------------------------------
const VORN_SITEMAP = "https://www.vorn.fo/sitemap.xml";
// Match any ban page under the (consistently-spelled) bradfeingis-veidibann
// directory, regardless of how the trailing slug word is spelled. Vørn has
// typo'd the slug per-ban — "veidbann" (nr 9), "veidibann" (10/11),
// "veidinann" (12), "veiibann" (13) — so anchoring on the veiðibann spelling
// (the old `veid[ib]+ann`) silently dropped nr 12/13. Anchor on the directory
// + a generic `-nr-<n>-<year>` tail instead. The `/kunning/tidindi/…` news
// archive lives under a different path, so it stays excluded.
const VORN_BAN_RE =
  /https:\/\/www\.vorn\.fo\/fiskiveida\/bradfeingis-veidibann\/[a-z]+-nr-[0-9]+-[0-9]{4}/gi;
// Pull the ban number + year from the `-nr-N-YYYY` tail without depending on
// the (unreliable) veiðibann spelling.
const VORN_NR_RE = /-nr-(\d+)-?(\d{4})/;
const VORN_COORD_RE =
  /(\d{2})(\d{2})\s*([NS])\s*[–-]\s*(\d{2,3})(\d{2})\s*([EWVØ])/gi;

export function vornSourceKey(url: string): string {
  const m = url.toLowerCase().match(VORN_NR_RE);
  return m ? `vorn-veidibann-${m[1]}-${m[2]}` : url.toLowerCase();
}

/** Canonical ban title derived from the URL — the page body sometimes opens
 * with a cross-reference to a prior ban, so the in-text regex picks the wrong
 * number. The URL number is authoritative. */
function vornTitleFromUrl(url: string): string | undefined {
  const m = url.toLowerCase().match(VORN_NR_RE);
  return m ? `Veiðibann nr. ${m[1]} - ${m[2]}` : undefined;
}

/** Extract the unique Vørn ban-page URLs from a sitemap XML body. Pure +
 * network-free so it can be unit-tested against a fixture. */
export function matchVornBanUrls(xml: string): string[] {
  return [...new Set(xml.match(VORN_BAN_RE) ?? [])];
}

export async function listVornBanUrls(): Promise<string[]> {
  const xml = await (
    await fetch(VORN_SITEMAP, { headers: { "user-agent": UA } })
  ).text();
  return matchVornBanUrls(xml);
}

/** Parse one Vørn ban page (raw HTML) into a ClosureRecord. */
export function parseVornBan(url: string, html: string): ClosureRecord {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  const rawPoints: ClosurePoint[] = [];
  for (const m of html.matchAll(VORN_COORD_RE)) {
    const latDeg = Number(m[1]);
    const latMin = Number(m[2]);
    const ns = m[3].toUpperCase();
    const lngDeg = Number(m[4]);
    const lngMin = Number(m[5]);
    const ew = m[6].toUpperCase();
    let lat = latDeg + latMin / 60;
    let lng = lngDeg + lngMin / 60;
    if (ns === "S") lat = -lat;
    if (ew === "W" || ew === "V") lng = -lng;
    rawPoints.push({ lat, lng });
  }
  // Vørn closes every ban ring by repeating the first vertex as the last. The
  // normaliser drops that duplicate — and recovers from a typo'd closing vertex
  // (see normalizeVornRing / nr 14-2026). A non-null `warning` means we had to
  // repair a malformed source ring: log it so the typo can be flagged to Vørn.
  const { points, warning } = normalizeVornRing(rawPoints);
  if (warning) {
    console.warn(
      `[Vorn] closure geometry normalized: ${vornSourceKey(url)} — ${warning.message}`,
      { sourceKey: vornSourceKey(url), url, ...warning },
    );
  }

  const gear = (text.match(/\b(trol|línu|lína|nót|garn|teinur)\b/i) || [])[1];
  const legalBasis = (text.match(/Løgtingslóg[^.]*\.?/i) || [])[0]?.trim();
  // "galdandi frá ... til ..." validity window (best-effort).
  const valid = text.match(/galdandi fr[áa]\s+([^.]{3,80})/i)?.[1]?.trim();

  return {
    region: "FO",
    source: "vorn",
    sourceKey: vornSourceKey(url),
    title: vornTitleFromUrl(url) || url,
    status: "active",
    closureType: "bráðfeingis veiðibann",
    gear,
    legalBasis,
    validFrom: valid,
    url,
    geometryType:
      points.length >= 3
        ? "polygon"
        : points.length === 2
          ? "polyline"
          : points.length === 1
            ? "point"
            : "none",
    points,
    bbox: bboxOf(points),
    bodyMarkdown: text.includes("Við heimild")
      ? text.slice(
          text.indexOf("Við heimild"),
          text.indexOf("Við heimild") + 1200,
        )
      : "",
  };
}

export async function fetchVornBan(url: string): Promise<ClosureRecord> {
  const html = await (
    await fetch(url, { headers: { "user-agent": UA } })
  ).text();
  return parseVornBan(url, html);
}

// ---------------------------------------------------------------------------
// 🇮🇸 Fiskistofa — public GeoServer WFS (gis.is). Active closure layers as
// GeoJSON polygons + attributes. No parsing of coordinates — geometry is
// already structured.
// ---------------------------------------------------------------------------
const FISKISTOFA_WFS = "https://gis.is/geoserver/fiskistofa/ows";
export const FISKISTOFA_LAYERS: Array<{ layer: string; closureType: string }> =
  [
    {
      layer: "virkar_skyndilokanir",
      closureType: "skyndilokun (temporary closure)",
    },
    {
      layer: "virk_hrygningarsvaedi",
      closureType: "hrygningarsvæði (spawning closure)",
    },
    {
      layer: "virk_grasleppulokanir",
      closureType: "grásleppulokun (lumpfish closure)",
    },
    {
      layer: "virk_dragnotaveidisvaedi",
      closureType: "dragnótaveiðisvæði (seine area)",
    },
    {
      layer: "virk_humarveidisvaedi",
      closureType: "humarveiðisvæði (lobster area)",
    },
    { layer: "virkar_reglugerdir", closureType: "reglugerð (regulation)" },
  ];

type GeoJsonFeature = {
  id?: string | number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
};

// Flowcore caps a single event at 64 000 bytes. Some Fiskistofa polygons carry
// thousands of vertices, which blows that limit (the announcement chunker splits
// body text, not geometry). The shared geo store indexes a MultiPoint + bbox, so
// full vertex resolution isn't needed — evenly decimate to keep events small
// while preserving the closure's shape and extent (first/last vertex kept).
const MAX_POINTS_PER_FEATURE = 600;

function decimate(points: ClosurePoint[], max: number): ClosurePoint[] {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: ClosurePoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

function ringPoints(geometry: GeoJsonFeature["geometry"]): {
  points: ClosurePoint[];
  geometryType: ClosureRecord["geometryType"];
} {
  if (!geometry) return { points: [], geometryType: "none" };
  const coords = geometry.coordinates as
    | number[][][]
    | number[][][][]
    | number[][];
  const flatten = (c: unknown): ClosurePoint[] => {
    const out: ClosurePoint[] = [];
    const walk = (x: unknown) => {
      if (
        Array.isArray(x) &&
        x.length >= 2 &&
        typeof x[0] === "number" &&
        typeof x[1] === "number"
      ) {
        out.push({ lng: x[0] as number, lat: x[1] as number });
      } else if (Array.isArray(x)) {
        for (const y of x) walk(y);
      }
    };
    walk(c);
    return out;
  };
  const pts = decimate(flatten(coords), MAX_POINTS_PER_FEATURE);
  const gt = /Polygon/i.test(geometry.type)
    ? "polygon"
    : /LineString/i.test(geometry.type)
      ? "polyline"
      : /Point/i.test(geometry.type)
        ? "point"
        : "none";
  return { points: pts, geometryType: gt as ClosureRecord["geometryType"] };
}

export function featureToClosure(
  layer: string,
  closureType: string,
  f: GeoJsonFeature,
): ClosureRecord {
  const p = f.properties || {};
  const str = (k: string) => {
    const v = p[k];
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    // Drop sentinels + JSON-ish junk ("{}", "[]", "null") that some layers
    // carry in attribute fields — they make for useless fragment titles.
    if (!t || t === "ENGAR UPPLÝSINGAR" || /^(\{\}|\[\]|null)$/i.test(t)) {
      return undefined;
    }
    return t;
  };
  const { points, geometryType } = ringPoints(f.geometry);
  // The GML `f.id` (e.g. "virk_…​.fid--3c475c88_19edf437561_-2d0a") embeds a
  // per-REQUEST token that changes on every WFS call, so it is NOT a stable key.
  // The feature's own `id`/`objectid` attribute is stable across requests — use
  // it so the sourceKey dedupes instead of duplicating the dataset each run.
  const stableId = p.id ?? p.objectid ?? p.fid;
  const fid = String(
    stableId !== undefined && stableId !== null ? stableId : (f.id ?? ""),
  );
  const title = str("heiti") || str("vfheiti") || `${closureType} ${fid}`;
  return {
    region: "IS",
    source: "fiskistofa-wfs",
    sourceKey: `fiskistofa-${layer}-${fid}`,
    title,
    status: "active",
    closureType,
    legalBasis: str("fors") || str("vmork"),
    species: str("teg_veidisvaeda"),
    validFrom: str("dags_fra"),
    validTo: str("dags_til"),
    url: "https://www.fiskistofa.is/fiskveidistjorn/skyndilokanir/",
    geometryType,
    points,
    bbox: bboxOf(points),
    bodyMarkdown: [str("skyring"), str("ath"), str("undanthaga")]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export async function fetchFiskistofaLayer(
  layer: string,
  closureType: string,
): Promise<ClosureRecord[]> {
  const url = `${FISKISTOFA_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=fiskistofa:${layer}&outputFormat=application/json`;
  const json = (await (
    await fetch(url, { headers: { "user-agent": UA } })
  ).json()) as {
    features?: GeoJsonFeature[];
  };
  return (json.features ?? []).map((f) =>
    featureToClosure(layer, closureType, f),
  );
}
