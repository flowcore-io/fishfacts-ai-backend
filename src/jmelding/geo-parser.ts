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
};

const NORWAY_BOX = { minLat: 54, maxLat: 82, minLon: -10, maxLon: 35 };
const DEDUP_EPSILON_DEG = 0.0001;

const DMS_RE =
  /(\d{1,3})\s*°\s*(\d{1,3})\s*'\s*([\d.,]+)\s*"\s*([NS])\s+(\d{1,3})\s*°\s*(\d{1,3})\s*'\s*([\d.,]+)\s*"\s*([EØW])/gi;

const DMM_LONG_RE =
  /(Nord|Sør|Sor)\s+(\d{1,3})\s*grader[.,]?\s+([\d.,]+)\s*minutter[.,]?\s+(Øst|Vest|Aust|Vest)\s+(\d{1,3})\s*grader[.,]?\s+([\d.,]+)\s*minutter/gi;

const DMM_SYMBOL_RE =
  /(\d{1,3})\s*°\s*([\d.,]+)\s*['°]\s*([NS])\s+(\d{1,3})\s*°\s*([\d.,]+)\s*['°]\s*([EØW])/gi;

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

function groupByName(matches: MatchedPoint[], text: string): NamedArea[] {
  const headings = findHeadings(text);
  const buckets = new Map<string, NamedArea>();
  const order: string[] = [];
  for (const m of matches) {
    const name = nearestHeading(headings, m.start, 1500);
    const key = name ?? "__unnamed__";
    let area = buckets.get(key);
    if (!area) {
      area = { name, points: [] };
      buckets.set(key, area);
      order.push(key);
    }
    area.points.push(m.point);
  }
  return order.map((key) => {
    const area = buckets.get(key);
    if (!area) throw new Error(`missing bucket ${key}`);
    return area;
  });
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
  const areas = groupByName(matches, text);
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
