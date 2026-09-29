export type GeoPoint = { lat: number; lon: number };
export type NamedArea = { name: string | null; points: GeoPoint[] };
export type Bbox = [
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
];
export type ParsedGeo = {
  areas: NamedArea[];
  bbox: Bbox | null;
  hasGeo: boolean;
};

type MatchedPoint = {
  point: GeoPoint;
  start: number;
  end: number;
  format: "dms" | "dmm-long" | "dmm-symbol" | "dmm-fo";
};

const NORWAY_BOX = { minLat: 54, maxLat: 82, minLon: -10, maxLon: 35 };
const DEDUP_EPSILON_DEG = 0.0001;

const DMS_RE =
  /(\d{1,3})\s*°\s*(\d{1,3})\s*'\s*([\d.,]+)\s*"\s*([NS])\s+(\d{1,3})\s*°\s*(\d{1,3})\s*'\s*([\d.,]+)\s*"\s*([EØW])/gi;

const DMM_LONG_RE =
  /(Nord|Sør|Sor)\s+(\d{1,3})\s*grader[.,]?\s+([\d.,]+)\s*minutter[.,]?\s+(Øst|Vest|Aust|Vest)\s+(\d{1,3})\s*grader[.,]?\s+([\d.,]+)\s*minutter/gi;

const DMM_SYMBOL_RE =
  /(\d{1,3})\s*°\s*([\d.,]+)\s*['°]\s*([NS])\s+(\d{1,3})\s*°\s*([\d.,]+)\s*['°]\s*([EØW])/gi;

// Vørn (FO) ban notices type each vertex as a bare degrees+minutes digit run
// with the hemisphere spelled out and a dash between the two halves:
// `6104 N - 0700 W`. No degree sign, no separator inside the number.
// (`normalize` has already folded Vørn's en dash to a hyphen.)
//
// Character-for-character the Vørn scraper's own `VORN_COORD_RE`, minutes
// permissiveness included, and that is the point: this reader runs over a
// STORED snapshot when an admin re-parses a case, so any divergence would let
// the queue and the map disagree about the same notice. It also means a
// hand-typed `6199 N` survives to the reviewer instead of being dropped as
// unreadable — which is the whole reason the queue exists.
const DMM_FO_RE = /(\d{2})(\d{2})\s*([NS])\s*-\s*(\d{2,3})(\d{2})\s*([EWVØ])/gi;

const HEADING_PATTERNS: { re: RegExp; group: number }[] = [
  { re: /^\s*-\s+([A-ZÆØÅa-zæøå][^\n]{0,79})$/gm, group: 1 },
  { re: /^\s*#{2,6}\s+([^\n]{1,80})$/gm, group: 1 },
  {
    re: /^\|\s*([A-ZÆØÅa-zæøå][^|\n]{0,40})\s*\|\s*([A-ZÆØÅa-zæøå][^|\n]{0,40})\s*\|/gm,
    group: 0,
  },
];

function normalize(input: string): string {
  return input
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\r\n/g, "\n");
}

function parseDecimalNumber(raw: string): number {
  return Number.parseFloat(raw.replace(",", "."));
}

function hemisphereSign(hemisphere: string): number {
  const first = hemisphere.charAt(0).toUpperCase();
  return first === "S" || first === "W" || first === "V" ? -1 : 1;
}

function dmmToDecimal(
  deg: number,
  decimalMinutes: number,
  hemisphere: string,
): number {
  const value = deg + decimalMinutes / 60;
  return hemisphereSign(hemisphere) * value;
}

function dmsToDecimal(
  deg: number,
  minutes: number,
  decimalSeconds: number,
  hemisphere: string,
): number {
  const value = deg + minutes / 60 + decimalSeconds / 3600;
  return hemisphereSign(hemisphere) * value;
}

function withinBounds(point: GeoPoint): boolean {
  return (
    point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180
  );
}

const FORMAT_PRIORITY: Record<MatchedPoint["format"], number> = {
  dms: 0,
  "dmm-long": 1,
  "dmm-symbol": 2,
  "dmm-fo": 3,
};

/**
 * A J-melding that amends a forskrift prints the changed paragraphs TWICE: once
 * under `§ N (endret) skal lyde:` near the top, then again inside the
 * consolidated forskrift that follows this marker. Only the consolidated text
 * is the regulation — the preamble is a restatement of it.
 *
 * Reading both halves is what used to lose whole areas: the preamble copy comes
 * first, so it won the proximity dedup, and the preamble's `§ 31 (ny) skal
 * lyde:` is not a markdown heading, so those vertices ended up nameless while
 * the real `### § 31` was left empty. Confirmed against J-144-2026, where
 * §§ 31–34 (the four paragraphs it adds) vanished this way.
 */
const CONSOLIDATED_MARKER_RE = /forskriften lyder etter dette\s*:/i;

/**
 * Every closure in a J-melding opens with its own "…forbudt å fiske… avgrenset
 * av rette linjer mellom følgende posisjoner" sentence. That sentence — not a
 * heading — is what reliably separates one area from the next: plenty of
 * J-meldinger (J-155-2026, twelve closures) carry no headings at all and are
 * otherwise read as a single 40-vertex blob.
 *
 * Deliberately loose about the lead-in's wording and terminator. The real
 * bodies vary ("Det er det forbudt", "Der et forbudt", `posisjoner:` vs
 * `posisjoner.`) and the phrase being matched is only the boundary — the
 * coordinates themselves are still read by the grammars above.
 */
const CLOSURE_LEAD_IN_RE =
  /(?:følgende|disse|avgrenses av følgende)\s+(?:posisjoner|koordinater|punkter)\s*[.:]/gi;

/**
 * Every lead-in starts a new area, with no attempt to judge from the prose
 * whether the run that follows continues the previous closure.
 *
 * The reader takes the coordinates and their order at face value. Deciding
 * that `herfra videre avgrenset i øst av rett linje mellom følgende posisjoner`
 * joins two runs into one closure — as § 1 of the seinot forskrift is worded —
 * is reading the statute, not reading coordinates, and reading it wrongly
 * produces a plausible shape nothing downstream can question.
 *
 * What each path then does with a two-vertex run, since neither is an admin
 * gate and it is worth not overstating them:
 *
 * - The regulation queue stores it unvalidated (`geometryValidated` false)
 *   and an admin validates or rejects it per area, which IS a review step.
 * - The map tiles drop it. `tiles/repository.ts` convex-hulls each feature's
 *   points and keeps only `POLYGON`/`MULTIPOLYGON`; two points hull to a
 *   LINESTRING, so § 1 contributes nothing to that layer rather than drawing
 *   as a line.
 *
 * So the trade is a closure that is absent from the tile layer against one
 * drawn as a shape we invented. § 1 is bounded by open lines plus the
 * coastline and was never derivable from the text — merging its runs only made
 * it LOOK derivable, as a four-corner quadrilateral against the authority's
 * 103-vertex coast polygon. Ingesting those polygons is what actually fixes
 * it; until then the map is short one closure it was previously drawing wrong.
 */

function dedupByProximity(matches: MatchedPoint[]): MatchedPoint[] {
  const byPriority = [...matches].sort(
    (a, b) => FORMAT_PRIORITY[a.format] - FORMAT_PRIORITY[b.format],
  );
  const kept: MatchedPoint[] = [];
  for (const candidate of byPriority) {
    const duplicate = kept.find(
      (k) =>
        Math.abs(k.point.lat - candidate.point.lat) < DEDUP_EPSILON_DEG &&
        Math.abs(k.point.lon - candidate.point.lon) < DEDUP_EPSILON_DEG,
    );
    if (!duplicate) kept.push(candidate);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

function findDmsMatches(text: string, sink: MatchedPoint[]): void {
  DMS_RE.lastIndex = 0;
  for (const match of text.matchAll(DMS_RE)) {
    if (match.index === undefined) continue;
    const lat = dmsToDecimal(
      Number(match[1]),
      Number(match[2]),
      parseDecimalNumber(match[3]),
      match[4],
    );
    const lon = dmsToDecimal(
      Number(match[5]),
      Number(match[6]),
      parseDecimalNumber(match[7]),
      match[8],
    );
    const point = { lat, lon };
    if (!withinBounds(point)) continue;
    sink.push({
      point,
      start: match.index,
      end: match.index + match[0].length,
      format: "dms",
    });
  }
}

function findDmmLongMatches(text: string, sink: MatchedPoint[]): void {
  DMM_LONG_RE.lastIndex = 0;
  for (const match of text.matchAll(DMM_LONG_RE)) {
    if (match.index === undefined) continue;
    const lat = dmmToDecimal(
      Number(match[2]),
      parseDecimalNumber(match[3]),
      match[1],
    );
    const lon = dmmToDecimal(
      Number(match[5]),
      parseDecimalNumber(match[6]),
      match[4],
    );
    const point = { lat, lon };
    if (!withinBounds(point)) continue;
    sink.push({
      point,
      start: match.index,
      end: match.index + match[0].length,
      format: "dmm-long",
    });
  }
}

function findDmmSymbolMatches(text: string, sink: MatchedPoint[]): void {
  DMM_SYMBOL_RE.lastIndex = 0;
  for (const match of text.matchAll(DMM_SYMBOL_RE)) {
    if (match.index === undefined) continue;
    const lat = dmmToDecimal(
      Number(match[1]),
      parseDecimalNumber(match[2]),
      match[3],
    );
    const lon = dmmToDecimal(
      Number(match[4]),
      parseDecimalNumber(match[5]),
      match[6],
    );
    const point = { lat, lon };
    if (!withinBounds(point)) continue;
    sink.push({
      point,
      start: match.index,
      end: match.index + match[0].length,
      format: "dmm-symbol",
    });
  }
}

function findDmmFoMatches(text: string, sink: MatchedPoint[]): void {
  DMM_FO_RE.lastIndex = 0;
  for (const match of text.matchAll(DMM_FO_RE)) {
    if (match.index === undefined) continue;
    const lat = dmmToDecimal(Number(match[1]), Number(match[2]), match[3]);
    const lon = dmmToDecimal(Number(match[4]), Number(match[5]), match[6]);
    const point = { lat, lon };
    if (!withinBounds(point)) continue;
    sink.push({
      point,
      start: match.index,
      end: match.index + match[0].length,
      format: "dmm-fo",
    });
  }
}

type Heading = { name: string; offset: number };

function isCoordinateLine(line: string): boolean {
  return (
    /\d{1,3}\s*°/.test(line) ||
    /grader.*minutter/i.test(line) ||
    /Nord\s+\d/i.test(line) ||
    /Øst\s+\d/i.test(line) ||
    /\d{4}\s*[NS]\s*-\s*\d{4,5}\s*[EWVØ]/i.test(line)
  );
}

function cleanHeading(raw: string): string {
  return raw
    .replace(/\|/g, " ")
    .replace(/^[\s\-#*]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The `## Kart` block a J-melding opens with lists the sea charts covering each
 * paragraph — `- Sjøkart Innhold § 1`, `- § 2`, … It reads exactly like the
 * bullet headings real area names come in, so without this the first closure of
 * a body with no consolidated marker is named after a chart link.
 *
 * Runs from the `## Kart` line to the first line that is neither blank nor a
 * bullet, which is where the regulation's own text starts.
 */
function kartTocRange(text: string): [number, number] | null {
  const kart = /^#{2,6}\s+Kart\s*$/m.exec(text);
  if (!kart) return null;
  const lines = text.slice(kart.index).split("\n");
  let offset = kart.index + lines[0].length + 1;
  for (const line of lines.slice(1)) {
    if (line.trim() !== "" && !line.trimStart().startsWith("-")) break;
    offset += line.length + 1;
  }
  return [kart.index, offset];
}

function findHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  const seen = new Set<number>();
  const toc = kartTocRange(text);
  for (const { re, group } of HEADING_PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
      // The heading patterns lead with `^\s*`, so a match can start on the
      // newline before its own line — compare the first real character.
      const textStart =
        match.index + (match[0].length - match[0].trimStart().length);
      if (toc && textStart >= toc[0] && textStart < toc[1]) continue;
      const lineText = match[0];
      if (isCoordinateLine(lineText)) continue;
      const captured = group === 0 ? lineText : match[group];
      if (!captured) continue;
      const name = cleanHeading(captured);
      if (!name || name.length < 2 || name.length > 80) continue;
      if (/^\d+\s*\./.test(name)) continue;
      if (seen.has(match.index)) continue;
      seen.add(match.index);
      headings.push({ name, offset: match.index });
    }
  }
  headings.sort((a, b) => a.offset - b.offset);
  return headings;
}

function nearestHeading(
  headings: Heading[],
  pointOffset: number,
  maxLookback: number,
): string | null {
  let candidate: Heading | null = null;
  for (const heading of headings) {
    if (heading.offset > pointOffset) break;
    if (pointOffset - heading.offset <= maxLookback) {
      candidate = heading;
    }
  }
  return candidate?.name ?? null;
}

/**
 * The consolidated forskrift, when the body carries one. Falls back to the whole
 * text if the marker is missing (a standalone forskrift, or a Vørn ban) or if
 * nothing follows it — a truncated snapshot must not silently parse to nothing.
 */
function consolidatedText(text: string): string {
  const marker = CONSOLIDATED_MARKER_RE.exec(text);
  if (!marker) return text;
  const after = text.slice(marker.index + marker[0].length);
  return after.trim().length > 0 ? after : text;
}

/** Offsets at which a new area begins, ascending. */
function findSegmentStarts(text: string, headings: Heading[]): number[] {
  const starts = new Set<number>(headings.map((h) => h.offset));
  CLOSURE_LEAD_IN_RE.lastIndex = 0;
  for (const match of text.matchAll(CLOSURE_LEAD_IN_RE)) {
    if (match.index === undefined) continue;
    starts.add(match.index);
  }
  return [...starts].sort((a, b) => a - b);
}

/**
 * One area per segment of the source, in source order.
 *
 * The name still comes from the nearest preceding heading, so the bullet- and
 * `###`-headed bodies keep the names they had. Where a body has no headings the
 * lead-in sentence itself becomes the name: it is verbatim source text rather
 * than a place name picked out of Norwegian prose, so it can be wrong only in
 * the way the source is.
 */
function groupBySegment(matches: MatchedPoint[], text: string): NamedArea[] {
  const headings = findHeadings(text);
  const starts = findSegmentStarts(text, headings);
  const segments: { name: string | null; matches: MatchedPoint[] }[] = [];
  let currentStart = Number.NaN;
  for (const m of matches) {
    let start = -1;
    for (const s of starts) {
      if (s > m.start) break;
      start = s;
    }
    if (segments.length === 0 || start !== currentStart) {
      segments.push({
        name: segmentName(text, headings, m.start, start),
        matches: [],
      });
      currentStart = start;
    }
    segments[segments.length - 1].matches.push(m);
  }
  // Dedup per area, not per document: it exists to collapse one position that
  // two grammars both matched (a table row printing DMS and DMM side by side),
  // and adjacent closures legitimately share a corner.
  return segments
    .map((s) => ({
      name: s.name,
      points: dedupByProximity(s.matches).map((m) => m.point),
    }))
    .filter((a) => a.points.length > 0);
}

function segmentName(
  text: string,
  headings: Heading[],
  pointOffset: number,
  segmentStart: number,
): string | null {
  const heading = nearestHeading(headings, pointOffset, 1500);
  if (heading) return heading;
  if (segmentStart < 0) return null;
  // The lead-in sentence, back to the start of its own line.
  const lineStart = text.lastIndexOf("\n", segmentStart) + 1;
  const name = cleanHeading(text.slice(lineStart, segmentStart));
  return name.length >= 2 ? name.slice(0, 80) : null;
}

function computeBbox(areas: NamedArea[]): Bbox | null {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const area of areas) {
    for (const point of area.points) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lon < minLon) minLon = point.lon;
      if (point.lon > maxLon) maxLon = point.lon;
      count++;
    }
  }
  if (count === 0) return null;
  return [
    Number(minLon.toFixed(6)),
    Number(minLat.toFixed(6)),
    Number(maxLon.toFixed(6)),
    Number(maxLat.toFixed(6)),
  ];
}

export function isInNorway(point: GeoPoint): boolean {
  return (
    point.lat >= NORWAY_BOX.minLat &&
    point.lat <= NORWAY_BOX.maxLat &&
    point.lon >= NORWAY_BOX.minLon &&
    point.lon <= NORWAY_BOX.maxLon
  );
}

export function parseJmeldingGeo(
  bodyMarkdown: string | undefined | null,
): ParsedGeo {
  if (!bodyMarkdown) {
    return { areas: [], bbox: null, hasGeo: false };
  }
  const text = consolidatedText(normalize(bodyMarkdown));
  const rawMatches: MatchedPoint[] = [];
  findDmsMatches(text, rawMatches);
  findDmmLongMatches(text, rawMatches);
  findDmmSymbolMatches(text, rawMatches);
  findDmmFoMatches(text, rawMatches);
  rawMatches.sort((a, b) => a.start - b.start);
  if (rawMatches.length === 0) {
    return { areas: [], bbox: null, hasGeo: false };
  }
  const areas = groupBySegment(rawMatches, text);
  if (areas.length === 0) {
    return { areas: [], bbox: null, hasGeo: false };
  }
  const bbox = computeBbox(areas);
  return {
    areas,
    bbox,
    hasGeo: bbox !== null,
  };
}

export type GeoJsonMultiPoint = {
  type: "MultiPoint";
  coordinates: [number, number][];
};

export type GeoJsonFeature = {
  type: "Feature";
  properties: { name: string | null };
  geometry: GeoJsonMultiPoint;
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

export function areasToFeatureCollection(
  areas: NamedArea[],
): GeoJsonFeatureCollection | null {
  const features: GeoJsonFeature[] = [];
  for (const area of areas) {
    if (area.points.length === 0) continue;
    features.push({
      type: "Feature",
      properties: { name: area.name },
      geometry: {
        type: "MultiPoint",
        coordinates: area.points.map((p) => [
          Number(p.lon.toFixed(6)),
          Number(p.lat.toFixed(6)),
        ]),
      },
    });
  }
  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}

/**
 * One MULTIPOINT for a vertex set, null on empty. Shared with the regulation
 * case projector so the queue's per-area `geom` and `jmelding_geo.geom` can
 * never drift in precision or format for the same announcement.
 */
export function pointsToMultipointWkt(points: GeoPoint[]): string | null {
  if (points.length === 0) return null;
  const inner = points
    .map((p) => `${p.lon.toFixed(6)} ${p.lat.toFixed(6)}`)
    .join(",");
  return `MULTIPOINT(${inner})`;
}

export function areasToWkt(areas: NamedArea[]): string | null {
  return pointsToMultipointWkt(areas.flatMap((area) => area.points));
}
