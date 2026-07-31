/**
 * Region-aware closure scrapers for the Faroe Islands (Vørn) and Iceland
 * (Fiskistofa). Both produce a `ClosureRecord` compatible with the j-melding
 * geo pipeline (region + geometry), so closures land in the SAME geo store and
 * are returned by the shared `search_regulations`/`get_regulation` tools.
 *
 * Pure fetch+parse — no DB/event deps — so they are unit/live testable in
 * isolation. The collector jobs map `ClosureRecord` → the discovered event.
 */
import { parseFaroeseValidityWindow, withExpiry } from "@/jmelding/validity";

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
//
// The year is `[0-9]+`, NOT `[0-9]{4}`: Vørn typo's the YEAR too. Nr 15 is
// published at `…-nr-15-20206` (five digits — their slug AND page title say
// "20206"; the image on the same page is named `veidibann-nr-15-2026.jpg`, so
// 2026 is intended). A `{4}` quantifier has no trailing boundary, so it
// matched only the first four digits and handed `…-nr-15-2020` downstream —
// a URL that 404s. We then scraped the 404 body, which has no coordinates and
// no "galdandi" sentence, and stored an in-force trawl ban with no geometry
// and no validity that could never expire. One missing boundary, four wrong
// fields. Take the whole digit run so we fetch the page that exists.
const VORN_BAN_RE =
  /https:\/\/www\.vorn\.fo\/fiskiveida\/bradfeingis-veidibann\/[a-z]+-nr-[0-9]+-[0-9]+/gi;
// Pull the ban number + year from the `-nr-N-YYYY` tail without depending on
// the (unreliable) veiðibann spelling. The year group is `\d+` for the same
// reason as above — a malformed year is kept VERBATIM in the key rather than
// silently truncated to a plausible-looking wrong one (`20206` → `2020` read
// as a 2020 ban). The title gets the real year from the body; see
// `vornTitleFromUrl`.
const VORN_NR_RE = /-nr-(\d+)-(\d+)/;
const VORN_COORD_RE =
  /(\d{2})(\d{2})\s*([NS])\s*[–-]\s*(\d{2,3})(\d{2})\s*([EWVØ])/gi;

export function vornSourceKey(url: string): string {
  const m = url.toLowerCase().match(VORN_NR_RE);
  return m ? `vorn-veidibann-${m[1]}-${m[2]}` : url.toLowerCase();
}

/** Canonical ban title derived from the URL — the page body sometimes opens
 * with a cross-reference to a prior ban, so the in-text regex picks the wrong
 * number. The URL NUMBER is authoritative.
 *
 * A WELL-FORMED URL year is authoritative too, and deliberately beats the
 * validity window: ban numbers reset annually, so the year in the title is the
 * ban's NUMBERING year, not the year it happens to be in force. A ban
 * published in December and effective from January would otherwise be retitled
 * into the next year and collide with that year's ban of the same number.
 *
 * Only a MALFORMED year defers to the body. Vørn published nr 15 as
 * `-nr-15-20206`, and "Veiðibann nr. 15 - 20206" (or, worse, a silently
 * truncated "- 2020") is what the user reads in the map popup. The validity
 * sentence is the one place on the page where the year is unambiguous — the
 * body at large is NOT safe to scan, since nr 15 cites "Løgtingslóg nr. 152
 * frá 23. desember 2019" and a naive first-year-in-body would title it 2019.
 * Falls back to the raw slug year when validity is unreadable too.
 */
function vornTitleFromUrl(
  url: string,
  validityYear?: string,
): string | undefined {
  const m = url.toLowerCase().match(VORN_NR_RE);
  if (!m) return undefined;
  const slugYear = m[2];
  const year = /^\d{4}$/.test(slugYear) ? slugYear : (validityYear ?? slugYear);
  return `Veiðibann nr. ${m[1]} - ${year}`;
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

  // Emit the coordinate points exactly as Vørn published them — including the
  // repeated closing vertex and any typo. The `fishfacts-announcement.0` event
  // is a faithful, immutable record of the source; ring cleanup (drop the
  // closing dup, repair typo'd rings) happens downstream in the geo projector
  // (see jmelding/vorn-ring.ts › normalizeVornRing), so history stays lossless
  // and can be replayed once the cleanup improves.
  const points: ClosurePoint[] = [];
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
    points.push({ lat, lng });
  }

  const gear = (text.match(/\b(trol|línu|lína|nót|garn|teinur)\b/i) || [])[1];
  const legalBasis = (text.match(/Løgtingslóg[^.]*\.?/i) || [])[0]?.trim();
  // "Veiðibannið er galdandi frá í dag, hin 1. juli 2026 klokkan 23:00 til
  // 29. juli 2026 klokkan 23:00." — parsed into real instants. A bráðfeingis
  // ban runs for a few weeks and Vørn leaves the page up afterwards, so
  // without an end date nothing downstream can tell that one has lapsed. (The
  // previous `[^.]{3,80}` capture stopped at the period in "1." and stored
  // "í dag, hin 1" as the start date.)
  const validity = parseFaroeseValidityWindow(text);

  return {
    region: "FO",
    source: "vorn",
    sourceKey: vornSourceKey(url),
    // The validity sentence is the only unambiguous year on the page, so it
    // beats a slug Vørn may have fat-fingered (see `vornTitleFromUrl`).
    title: vornTitleFromUrl(url, validity.validFrom?.slice(0, 4)) || url,
    // Vørn publishes no status field — a ban is in force until its window
    // closes, which is exactly what `withExpiry` decides.
    status: withExpiry("active", validity.validTo),
    closureType: "bráðfeingis veiðibann",
    gear,
    legalBasis,
    validFrom: validity.validFrom,
    validTo: validity.validTo,
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
  const validTo = str("dags_til");
  return {
    region: "IS",
    source: "fiskistofa-wfs",
    sourceKey: `fiskistofa-${layer}-${fid}`,
    title,
    // The layer is named "virkar_…" (active) but we keep every feature we have
    // ever seen, so a closure that has since run out must expire on its own
    // `dags_til` rather than stay active forever.
    status: withExpiry("active", validTo),
    closureType,
    legalBasis: str("fors") || str("vmork"),
    species: str("teg_veidisvaeda"),
    validFrom: str("dags_fra"),
    validTo,
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
