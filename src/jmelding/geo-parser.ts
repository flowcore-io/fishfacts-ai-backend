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
  format: "dms" | "dmm-long" | "dmm-symbol";
  /** The `1.` / `2.` the notice numbers this position with, when it has one. */
  ordinal: number | null;
};

const NORWAY_BOX = { minLat: 54, maxLat: 82, minLon: -10, maxLon: 35 };
const DEDUP_EPSILON_DEG = 0.0001;

const DMS_RE =
  /(\d{1,3})\s*°\s*(\d{1,3})\s*'\s*([\d.,]+)\s*"\s*([NS])\s+(\d{1,3})\s*°\s*(\d{1,3})\s*'\s*([\d.,]+)\s*"\s*([EØW])/gi;

const DMM_LONG_RE =
  /(Nord|Sør|Sor)\s+(\d{1,3})\s*grader[.,]?\s+([\d.,]+)\s*minutter[.,]?\s+(Øst|Vest|Aust|Vest)\s+(\d{1,3})\s*grader[.,]?\s+([\d.,]+)\s*minutter/gi;

const DMM_SYMBOL_RE =
  /(\d{1,3})\s*°\s*([\d.,]+)\s*['°]\s*([NS])\s+(\d{1,3})\s*°\s*([\d.,]+)\s*['°]\s*([EØW])/gi;

// A notice numbers each closure's corner positions `1. … 2. … N.` and starts
// over at `1.` for the next one, so the ordinal immediately in front of a
// coordinate tells us where one ring ends and the next begins.
const POSITION_ORDINAL_RE = /(\d{1,2})\s*[.)]\s*$/;
const ORDINAL_LOOKBEHIND_CHARS = 8;

// Evidence, in the prose BETWEEN two consecutive positions, that the notice has
// moved on to a different closure. Any one of them ends the current ring.
const SECTION_MARKER_RE = /§+\s*\d+/;
const SECTION_MARKER_RE_G = /§+\s*\d+/g;
const RING_TERMINATOR_RE =
  /her(?:fra|ifra)\b[\s\S]{0,80}?\b(?:posisjon|pkt\.?|punkt)\s*1\b/i;
const CLOSURE_LEAD_IN_RE =
  /følgende posisjoner|avgrenset av rette linjer|det er forbudt/i;

// "… på Gåsværfjorden og Mesøyfjorden i Nordland avgrenset av …" — the place a
// lead-in names, taken from the source's own capitalisation rather than a
// gazetteer. Used only to label an area; nothing renders off it.
const PLACE_IN_COUNTY_RE =
  /\b(?:på|ved|i)\s+(\p{Lu}[\p{L}-]*(?:\s+og\s+\p{Lu}[\p{L}-]*)*)\s+i\s+(\p{Lu}[\p{L}-]*(?:\s+og\s+\p{Lu}[\p{L}-]*)*)/u;
/** "Område A" / "Område B" — the label some notices give a ring instead of a §. */
const AREA_LABEL_RE_G = /^\s*Område\s+[^\n]{1,20}$/gm;
const LEAD_IN_TAIL_CHARS = 400;
/** How far back a heading may sit and still be taken as an area's label. */
const HEADING_NAME_LOOKBACK_CHARS = 1500;

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
};

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

function readPositionOrdinal(text: string, matchStart: number): number | null {
  const before = text.slice(
    Math.max(0, matchStart - ORDINAL_LOOKBEHIND_CHARS),
    matchStart,
  );
  const matched = before.match(POSITION_ORDINAL_RE);
  return matched ? Number(matched[1]) : null;
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
      ordinal: readPositionOrdinal(text, match.index),
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
      ordinal: readPositionOrdinal(text, match.index),
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
      ordinal: readPositionOrdinal(text, match.index),
    });
  }
}

type Heading = { name: string; offset: number };

function isCoordinateLine(line: string): boolean {
  return (
    /\d{1,3}\s*°/.test(line) ||
    /grader.*minutter/i.test(line) ||
    /Nord\s+\d/i.test(line) ||
    /Øst\s+\d/i.test(line)
  );
}

function cleanHeading(raw: string): string {
  return raw
    .replace(/\|/g, " ")
    .replace(/^[\s\-#*]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  const seen = new Set<number>();
  for (const { re, group } of HEADING_PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (match.index === undefined) continue;
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
 * True when the notice itself says the previous ring has ended: its position
 * numbering starts over, it closes the ring back to position 1, it opens a new
 * `§`, it introduces another closure, or it moves under a different heading.
 *
 * Grouping used to key on the heading alone, which merged every closure a
 * notice listed under one heading into a single ring — J-95-2026's eight fjord
 * closures came out as two areas and drew as edges from Finnmark to Trøndelag
 * (report d981acd8).
 */
function startsNewArea(
  previous: MatchedPoint,
  current: MatchedPoint,
  gap: string,
  previousHeading: string | null,
  currentHeading: string | null,
): boolean {
  // A restart, not merely a repeat: J-125-2026 § 12 numbers its last two
  // corners "5." and "5." — a source typo inside one ring, not a new closure.
  if (
    previous.ordinal !== null &&
    current.ordinal !== null &&
    (current.ordinal === 1 || current.ordinal < previous.ordinal)
  ) {
    return true;
  }
  if (RING_TERMINATOR_RE.test(gap)) return true;
  if (SECTION_MARKER_RE.test(gap)) return true;
  if (CLOSURE_LEAD_IN_RE.test(gap)) return true;
  return currentHeading !== previousHeading;
}

/**
 * A label for the closure, taken only from what the source states — the heading
 * it sits under, else the "Område X" it is called, the place its lead-in names,
 * or the `§` it opens. Never invented: nothing renders off this, but the
 * assistant reads it back.
 */
function areaNameFor(gap: string, heading: string | null): string | null {
  if (heading) return heading;
  const tail = gap.slice(-LEAD_IN_TAIL_CHARS);
  const labels = tail.match(AREA_LABEL_RE_G);
  if (labels) return labels.at(-1)?.trim() ?? null;
  const place = tail.match(PLACE_IN_COUNTY_RE);
  if (place) return `${place[1]} i ${place[2]}`;
  const sections = tail.match(SECTION_MARKER_RE_G);
  return sections?.at(-1) ?? null;
}

function groupIntoAreas(matches: MatchedPoint[], text: string): NamedArea[] {
  const headings = findHeadings(text);
  const areas: NamedArea[] = [];
  let current: NamedArea | null = null;
  let previous: MatchedPoint | null = null;
  let previousHeading: string | null = null;
  for (const m of matches) {
    // Which heading we sit under is unbounded — a section does not end because
    // its ring runs past the naming window. Bounding both is what used to cut
    // J-117-2026's Varanger closure in half after its second corner.
    const heading = nearestHeading(headings, m.start, Number.POSITIVE_INFINITY);
    const label = nearestHeading(
      headings,
      m.start,
      HEADING_NAME_LOOKBACK_CHARS,
    );
    const gap =
      previous === null
        ? text.slice(0, m.start)
        : text.slice(previous.end, m.start);
    if (
      current === null ||
      previous === null ||
      startsNewArea(previous, m, gap, previousHeading, heading)
    ) {
      current = { name: areaNameFor(gap, label), points: [] };
      areas.push(current);
    }
    current.points.push(m.point);
    previous = m;
    previousHeading = heading;
  }
  return areas;
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
  const text = normalize(bodyMarkdown);
  const rawMatches: MatchedPoint[] = [];
  findDmsMatches(text, rawMatches);
  findDmmLongMatches(text, rawMatches);
  findDmmSymbolMatches(text, rawMatches);
  const matches = dedupByProximity(rawMatches);
  if (matches.length === 0) {
    return { areas: [], bbox: null, hasGeo: false };
  }
  const areas = groupIntoAreas(matches, text);
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

export function areasToWkt(areas: NamedArea[]): string | null {
  const allPoints: GeoPoint[] = [];
  for (const area of areas) {
    for (const point of area.points) allPoints.push(point);
  }
  if (allPoints.length === 0) return null;
  const inner = allPoints
    .map((p) => `${p.lon.toFixed(6)} ${p.lat.toFixed(6)}`)
    .join(",");
  return `MULTIPOINT(${inner})`;
}
