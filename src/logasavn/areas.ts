/**
 * Extract named closure areas + geometry from Lógasavn statute fragments.
 *
 * The Faroese law corpus lives in the Usable "Lógasavn" workspace as markdown
 * mirrors of logir.fo. Statutes define closures as ordered vertex lists in
 * prose, so this module turns one statute's markdown into drawable rings.
 *
 * Pure + network-free so it can be unit-tested against fixtures, the same way
 * `parseVornBan` is.
 *
 * Every rule below was established by parsing the real corpus and checking the
 * output area-by-area; each one has a statute that breaks if it is dropped.
 */

export type AreaPoint = { lat: number; lng: number };

export type ParsedArea = {
  /** Statute's own name for the area (`B`, `a`, `1`), verbatim. Null when the
   *  statute describes the area in prose instead of naming it. */
  name: string | null;
  points: AreaPoint[];
  /** Coordinates found in the block's prose rather than its vertex list —
   *  bearing origins, bounding parallels, named landmarks. Never vertices. */
  descriptorCount: number;
  ringClosed: boolean;
  /** True when the vertex run did not pair cleanly, which means the boundary is
   *  described rather than enumerated. Callers MUST NOT draw these. */
  descriptive: boolean;
};

// The corpus uses FOUR notations for the same thing. A parser that knows only
// one silently returns ZERO areas for the statutes using the others — which is
// not a visible failure, it is an area quietly missing from the map:
//
//   61°12,000'N     decimal minutes, comma, apostrophe terminator  (K 30/2018)
//   62°05,700 N     decimal minutes, comma, no terminator          (K 193/2017)
//   62°00´000 N     decimal minutes, ACUTE ACCENT separator        (K 193/2017 § 9a)
//   60°57'20"N      degrees-minutes-SECONDS                        (K 35/2026)
//
// K 35/2026 is the Føroyabanki statute — the area users ask for by name — and
// it is entirely deg-min-seconds.
//
// Seconds MUST be tried first. Against `60°57'20"N` the decimal-minutes branch
// half-matches `60°57'` and discards the seconds, moving the vertex by up to a
// full minute (~1 nm) with nothing raised.
const COORD_DMS = String.raw`(\d{1,3})\s*°\s*(\d{1,2})\s*['´]\s*(\d{1,2}(?:[.,]\d+)?)\s*"\s*([NSVWEA])`;
const COORD_DM = String.raw`(\d{1,3})\s*°\s*(\d{1,2})\s*[.,´']\s*(\d{1,3})\s*['´]?\s*([NSVWEA])`;
const COORD_RE = new RegExp(`(?:${COORD_DMS})|(?:${COORD_DM})`, "gi");

/** A markdown list item: `- **1)**…` or the indented `  - **a)**…`. */
const ITEM_RE = /^[ \t]*-\s*\*\*[0-9a-zA-ZáíóúýðæøåÁÍÓÚÝÐÆØÅ]{1,3}\)\*\*(.*)$/;

/** A §/Stk. heading always opens a new area block. */
const HEADING_RE = /\*\*Stk\.\s*\d+\.\*\*|###\s*§\s*\d+/;

/** `Øki 1`, `øki a`, `Øki B`. Case is SEMANTIC — see `nameOf`. */
const NAME_RE = /[ØøOo]ki\s+([A-Za-zÁÍÓÚÝÐÆØÅáíóúýðæøå0-9]{1,3})\b/;

const LATITUDE_HEMISPHERES = new Set(["N", "S"]);
// V = vestur (west), A = eystur (east) — Faroese; W/E appear in translated text.
const LONGITUDE_HEMISPHERES = new Set(["V", "W", "E", "A"]);

type RawCoordinate = { degrees: number; minutes: number; hemisphere: string };

/** Collapse whichever notation matched into degrees + decimal minutes. */
function coordinateFrom(match: RegExpExecArray): RawCoordinate {
  const [, dmsDeg, dmsMin, dmsSec, dmsHemi, dmDeg, dmMin, dmFrac, dmHemi] =
    match;
  if (dmsHemi) {
    return {
      degrees: Number(dmsDeg),
      minutes: Number(dmsMin) + Number(dmsSec.replace(",", ".")) / 60,
      hemisphere: dmsHemi.toUpperCase(),
    };
  }
  return {
    degrees: Number(dmDeg),
    minutes: Number(`${dmMin}.${dmFrac}`),
    hemisphere: dmHemi.toUpperCase(),
  };
}

function toDecimal({ degrees, minutes, hemisphere }: RawCoordinate): number {
  const value = degrees + minutes / 60;
  return hemisphere === "S" || hemisphere === "V" || hemisphere === "W"
    ? -value
    : value;
}

function matchCoordinates(text: string): RawCoordinate[] {
  const out: RawCoordinate[] = [];
  COORD_RE.lastIndex = 0;
  let match = COORD_RE.exec(text);
  while (match != null) {
    out.push(coordinateFrom(match));
    match = COORD_RE.exec(text);
  }
  return out;
}

/**
 * True when a list item OPENS with a lone coordinate pair.
 *
 * A vertex reads `61°40,000 N - 008°25,000 V`. A descriptor reads
 * `…millum 315° rættvísandi úr Barðinum, 62°08,800 N - 007°26,000 V, og…` —
 * a fully-paired coordinate inside a sentence, so pair-completeness cannot tell
 * them apart. The PREFIX can: a vertex has nothing before its first coordinate.
 *
 * Anchoring on the prefix rather than requiring the whole item to be clean is
 * deliberate. The markdown routinely glues the next section's heading onto the
 * final vertex's line (`- **10)**60°57'20"N - 07°57'00"V Fiskidagatal`), and
 * that final vertex is the ring-closing one. A stricter test drops it, the ring
 * reads as open, and the area is quietly the wrong shape.
 */
export function isVertexItem(text: string): boolean {
  COORD_RE.lastIndex = 0;
  const first = COORD_RE.exec(text);
  if (first == null) return false;
  const matches = matchCoordinates(text);
  if (matches.length !== 2) return false; // exactly one latitude + one longitude
  const prefix = text.slice(0, first.index).replace(/[\s\-–—,;:.()´'"]+/g, "");
  return prefix.length <= 2;
}

/**
 * Cut a statute into candidate area blocks.
 *
 * A block opens at a §/Stk. heading, or at a list item stating a RULE. It must
 * NOT open at a list item that is itself a vertex: statutes disagree on what
 * their numbering means. K 30/2018 numbers its VERTICES `**1)**`, while
 * K 45/2022 numbers its RULES `**1)**` and letters its vertices `**a)**`. Split
 * on every numbered item and the first family collapses to one coordinate per
 * block and yields nothing; never split on them and the second family merges
 * four separate spawning closures into one polygon.
 */
export function splitBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of content.split("\n")) {
    const item = ITEM_RE.exec(line);
    const opensBlock =
      HEADING_RE.test(line) || (item != null && !isVertexItem(item[1]));
    if (opensBlock && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Pair each latitude with the longitude that follows it.
 *
 * Pairing by POSITION instead desynchronises on the bare single-axis references
 * statutes use (`norðan fyri breiddarstigið 62°25,000'N`), and every subsequent
 * vertex is then garbage — the earlier prototype produced a South Atlantic
 * vertex this way, with no error raised. An unpairable coordinate is reported
 * rather than skipped: it means the boundary is described, not enumerated.
 */
function pairByHemisphere(coords: RawCoordinate[]): {
  points: AreaPoint[];
  orphans: number;
} {
  const points: AreaPoint[] = [];
  let orphans = 0;
  let pendingLat: number | null = null;
  for (const coord of coords) {
    if (LATITUDE_HEMISPHERES.has(coord.hemisphere)) {
      if (pendingLat != null) orphans += 1;
      pendingLat = toDecimal(coord);
    } else if (LONGITUDE_HEMISPHERES.has(coord.hemisphere)) {
      if (pendingLat == null) {
        orphans += 1;
        continue;
      }
      points.push({ lat: pendingLat, lng: toDecimal(coord) });
      pendingLat = null;
    }
  }
  if (pendingLat != null) orphans += 1;
  return { points, orphans };
}

/**
 * The area's name, verbatim.
 *
 * Case is NOT normalised, because it carries meaning: `Øki A` is the Føroya
 * Banki closure and `øki a` is the zone inside it where fishing IS permitted
 * between 1 September and 31 May. Same for D/d and F/f. Upper-casing merges a
 * closure with its own exemption and draws the closure over the water it
 * explicitly excludes.
 */
function nameOf(block: string): string | null {
  return NAME_RE.exec(block)?.[1] ?? null;
}

/** Parse one statute's markdown into its areas. */
export function extractAreas(content: string): ParsedArea[] {
  const areas: ParsedArea[] = [];
  for (const block of splitBlocks(content)) {
    const items: string[] = [];
    for (const line of block.split("\n")) {
      const item = ITEM_RE.exec(line);
      if (item != null) items.push(item[1]);
    }
    const vertexText = items.filter(isVertexItem);
    const coords = vertexText.flatMap(matchCoordinates);
    if (coords.length < 3) continue;

    const descriptorCount = matchCoordinates(block).length - coords.length;
    const { points, orphans } = pairByHemisphere(coords);
    if (points.length < 3) continue;

    const first = points[0];
    const last = points[points.length - 1];
    areas.push({
      name: nameOf(block),
      points,
      descriptorCount,
      ringClosed: first.lat === last.lat && first.lng === last.lng,
      descriptive: orphans > 0,
    });
  }
  return areas;
}

/** Areas safe to draw: a described boundary is never one of them. */
export function drawableAreas(content: string): ParsedArea[] {
  return extractAreas(content).filter((area) => !area.descriptive);
}
