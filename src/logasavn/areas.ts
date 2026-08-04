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
  /** Statute's own name for the area (`B`, `a`, `1`, `HAR 1`), verbatim. Null
   *  when the statute describes the area in prose instead of naming it. */
  name: string | null;
  points: AreaPoint[];
  /** Coordinates found in the block's prose rather than its vertex list —
   *  bearing origins, bounding parallels, named landmarks. Never vertices. */
  descriptorCount: number;
  ringClosed: boolean;
  /** True when the vertex run did not pair cleanly, which means the boundary is
   *  described rather than enumerated. Callers MUST NOT draw these. */
  descriptive: boolean;
  /**
   * Lines that read as vertices to the loose detector but that the tokenizer
   * could not consume — i.e. geometry we know we failed to understand.
   *
   * Non-zero means the ring is INCOMPLETE, not merely unusual, so the area is
   * withheld from `drawableAreas`. See `looksLikeVertexItem` for why this is
   * the signal worth failing closed on.
   */
  unparsed: number;
};

// A survey of all 7,405 Lógasavn fragments found 135 distinct coordinate shapes
// (Usable Knowledge 714320cb). Enumerating them one regex branch at a time is
// how you arrive at 135, so this is ONE grammar with the separators as
// character classes instead:
//
//   61°12,000'N        decimal minutes, comma, apostrophe terminator
//   62°05,700 N        decimal minutes, no terminator
//   62°00´000 N        ACUTE ACCENT as the decimal separator
//   62°24´7090 N       ...with a FOUR digit fraction
//   57°59.96 N         full stop as the decimal separator
//   60°57'20"N         degrees-minutes-SECONDS
//   60°20'00''N        ...seconds closed by two apostrophes, not a quote
//   48° 17’39’’N       ...in typographic quotes, with spaces
//   61° 20’ 10’’.85 N  ...with the decimal AFTER the seconds mark
//   59° 45' N          degrees and minutes only
//   62°N               degrees only — a bounding parallel, or a box corner
//   61º49'00"N         `º` U+00BA masculine ordinal, NOT `°` U+00B0
//
// The body between the degree sign and the hemisphere is captured whole and
// interpreted by `minutesFrom`, because the alternation needed to do that
// inside one regex is unreadable and its group numbering is a maintenance trap.
/** Degree sign proper, plus the `º` masculine ordinal it gets typed as. */
const DEGREE_SIGN = String.raw`[°º]`;
/**
 * Apostrophe, acute accent, typographic single quotes, prime — and the cent
 * sign.
 *
 * `¢` (U+00A2) is not a punctuation mark anybody chose: K 38/2017 writes
 * `48° 27¢ N`, an encoding artefact where the prime became a currency symbol
 * somewhere upstream of logir.fo. It is the only statute in the corpus that
 * does it, and it accounts for every remaining coordinate the tokenizer could
 * not read across all 48 in-force candidates.
 */
const MINUTE_CHARS = String.raw`'´’‘′¢`;
/**
 * Double quote, typographic double quotes and the double-prime; two minute
 * marks in a row read as one.
 *
 * `”` (U+201D, RIGHT DOUBLE QUOTATION MARK) earns its place from K 197/2021,
 * the NAFO closures, which writes `42°31’33” N` — a typographic double quote as
 * the seconds mark where the rest of the corpus uses `"` (U+0022) or `″`
 * (U+2033). The minute mark in the same coordinate is `’`, which WAS known, so
 * the tokenizer read halfway through each vertex and then stopped: eighteen of
 * that statute's nineteen closures parsed to nothing.
 *
 * Found by the gap between this and `COORD_LIKE`, which does not care what sits
 * between the degree sign and the hemisphere and so saw every one of them. That
 * is the whole reason the loose detector is written to over-trigger.
 */
const SECOND_CHARS = String.raw`"”“″`;
const HEMISPHERE = String.raw`[NSVWEA]`;
/** Digits, whitespace and separators only — no letters, so prose can't leak in. */
const COORD_BODY = String.raw`[\d\s.,${MINUTE_CHARS}${SECOND_CHARS}]*?`;

const COORD_RE = new RegExp(
  String.raw`(\d{1,3})\s*${DEGREE_SIGN}\s*(${COORD_BODY})\s*(${HEMISPHERE})(?![\p{L}])`,
  "giu",
);

/**
 * Deliberately LOOSER than `COORD_RE`: same anchors, but anything non-alphabetic
 * may sit between the degree sign and the hemisphere.
 *
 * The gap between the two is the whole safety net. K 102/2024 — the in-force
 * NEAFC annex — parsed to ZERO under the previous regexes with nothing raised,
 * and ten more in-force statutes parsed only PARTIALLY, which is worse: a ring
 * missing vertices still draws, just in the wrong place. A detector that only
 * knows the notations we already handle cannot report either case, so this one
 * is written to over-trigger.
 *
 * Letters are excluded from the window so bearing origins (`315° rættvísandi úr
 * Barðinum`) do not register — they are degree-sign uses with no hemisphere.
 */
const COORD_LIKE = new RegExp(
  String.raw`\d{1,3}\s*${DEGREE_SIGN}[^\p{L}\n]{0,28}?${HEMISPHERE}(?![\p{L}])`,
  "giu",
);

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

/**
 * Turn the body between the degree sign and the hemisphere into decimal minutes.
 *
 * The discriminator between the two families is the SECONDS mark, not the
 * separator: `62°00´000 N` and `60°20'00''N` are both `<num> mark <num>`, and
 * only the doubled mark on the second says its trailing number is seconds
 * rather than a decimal fraction. Reading `00´000` as 0 minutes 0 seconds would
 * silently collapse three vertices of K 193/2017 onto the same point.
 */
function minutesFrom(body: string): number {
  // Normalise the mark zoo first: every minute mark to `'`, every seconds mark
  // to `"`, so the checks below don't have to repeat the character classes.
  const marks = body.replace(/[´’‘′¢]/g, "'").replace(/[″”“]/g, '"');
  const normalised = marks.replace(/''/g, '"');

  const secondsMark = normalised.indexOf('"');
  if (secondsMark !== -1) {
    // Degrees-minutes-seconds. Fractional seconds appear on BOTH sides of the
    // seconds mark in the corpus — `65° 41′ 22.63″ N` (Anordning 598/1976)
    // attaches the decimal to the digits, `61° 20’ 10’’.85 N` (Løgtingslóg
    // 80/2003) puts it after the mark. Reading only one form drops the fraction
    // silently and moves the vertex ~19 m, which no test on vertex COUNT can
    // catch — only asserting the value does.
    const head = normalised.slice(0, secondsMark);
    const tail = normalised.slice(secondsMark + 1);
    const [minutes = "0", seconds = "0"] =
      head.match(/\d+(?:[.,]\d+)?/g)?.map((n) => n.replace(",", ".")) ?? [];
    const trailing = /^\s*[.,](\d+)/.exec(tail)?.[1];
    const wholeSeconds = seconds.includes(".")
      ? Number(seconds)
      : Number(`${seconds}.${trailing ?? "0"}`);
    return Number(minutes) + wholeSeconds / 60;
  }

  // Decimal minutes. Any mark sitting BETWEEN digits is acting as the decimal
  // separator — `,` and `.` obviously, but also `´` in K 193/2017 § 9a.
  const decimal = marks.replace(/(\d)\s*['.,]\s*(\d)/g, "$1.$2");
  const digits = decimal.match(/\d+(?:\.\d+)?/g);
  if (digits == null || digits.length === 0) return 0; // `62°N` — degrees only
  return Number(digits[0]);
}

/** Collapse whichever notation matched into degrees + decimal minutes. */
function coordinateFrom(match: RegExpExecArray): RawCoordinate {
  const [, degrees, body, hemisphere] = match;
  return {
    degrees: Number(degrees),
    minutes: minutesFrom(body ?? ""),
    hemisphere: hemisphere.toUpperCase(),
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
 * How many coordinate-like constructs the LOOSE detector sees.
 *
 * Exported because the corpus sweep needs exactly this question answered per
 * fragment — "could this statute contain geometry?" — and it must be asked with
 * the same over-triggering detector the quarantine uses, or the two disagree
 * about what counts as a coordinate and fragments fall through the gap.
 */
export function countCoordinateLike(text: string): number {
  COORD_LIKE.lastIndex = 0;
  let count = 0;
  while (COORD_LIKE.exec(text) != null) count += 1;
  return count;
}

/**
 * A row of a `Talva N … Breiddarstig Longdarstig` table: an index, a signed
 * latitude and a signed longitude, all in plain decimal degrees.
 *
 * This is the regex the deleted table EXTRACTOR was built on, kept alive on the
 * detection side only. The notation carries no degree sign and no hemisphere
 * letter, so `COORD_LIKE` cannot see it at all — and K 102/2024's annex is
 * written entirely in it. Without this the sweep would omit those statutes from
 * the index outright, which is the one failure recall cannot tolerate: the
 * expert answers what it is asked and cannot ask about a statute nobody listed.
 *
 * Detecting is safe where extracting was not. The shape says "these are
 * coordinates"; only the prose above the table says whether they mean keep out
 * or fish here, and the reader who can tell is the one the index is for.
 */
const TABLE_ROW_RE = /(?:^|\s)\d{1,3}\s+-?\d{1,3}\.\d+\s+-?\d{1,3}\.\d+/g;

export function countDecimalDegreeRows(text: string): number {
  TABLE_ROW_RE.lastIndex = 0;
  let count = 0;
  while (TABLE_ROW_RE.exec(text) != null) count += 1;
  return count;
}

const countLoose = countCoordinateLike;

/** Nothing but separators before the first coordinate — see `isVertexItem`. */
function hasVertexPrefix(text: string, firstIndex: number): boolean {
  const prefix = text.slice(0, firstIndex).replace(/[\s\-–—,;:.()´'"]+/g, "");
  return prefix.length <= 2;
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
  return hasVertexPrefix(text, first.index);
}

/**
 * True when an item reads as a vertex to the LOOSE detector.
 *
 * Used only to catch what `isVertexItem` missed. A vertex line written in a
 * notation the tokenizer does not know fails `isVertexItem`, drops out of the
 * ring, and leaves no trace — the polygon simply has fewer corners than the
 * statute says. That is the failure that made ten in-force statutes parse
 * partially, and it is why `unparsed` exists.
 */
function looksLikeVertexItem(text: string): boolean {
  COORD_LIKE.lastIndex = 0;
  const first = COORD_LIKE.exec(text);
  if (first == null) return false;
  return countLoose(text) === 2 && hasVertexPrefix(text, first.index);
}

/**
 * A line that is BOTH a vertex and the next section's opener.
 *
 * The markdown routinely glues what follows onto the ring-closing vertex's line,
 * and today that is always a bare title word (`…07°57'00"V Fiskidagatal`) —
 * 0 of the corpus's 5,508 vertex lines also match `HEADING_RE`. The corpus is
 * re-scraped in place though, so the day one glues a `**Stk. N.**` instead,
 * every available reading is wrong: split before the line and the closing vertex
 * migrates into the next block, tearing both rings; never split and two distinct
 * areas merge into one polygon; split after and the glued text — which may name
 * the NEXT area (`**Stk. 2.** Í øki B…`) — stays behind and mislabels THIS one.
 *
 * Segmentation is genuinely undecidable there, so the area is withheld and
 * counted rather than guessed at. Same principle as an unreadable notation: an
 * honest gap beats a confident wrong shape.
 */
function isAmbiguousVertexHeading(line: string): boolean {
  const item = ITEM_RE.exec(line);
  if (item == null) return false;
  if (!isVertexItem(item[1]) && !looksLikeVertexItem(item[1])) return false;
  return HEADING_RE.test(line);
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
    // A line the tokenizer cannot read is still a vertex line — split on it and
    // the ring is torn in half on top of losing the vertex.
    const isVertex =
      item != null && (isVertexItem(item[1]) || looksLikeVertexItem(item[1]));
    // A vertex line never opens a block, whatever else is glued to it — see
    // `isAmbiguousVertexHeading` for the case this protects against and why the
    // area is then withheld rather than guessed at.
    const opensBlock = !isVertex && (HEADING_RE.test(line) || item != null);
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
 * Read ONE vertex written in the statute's own notation.
 *
 * Exported for the closure gate, which compares an LLM's reading of a statute
 * against this parser's. The LLM is asked to quote each vertex VERBATIM rather
 * than to convert it, and the quote is then run through this — the same
 * tokenizer, the same arithmetic — so the two sides differ only where they
 * disagree about what the statute SAYS. Ask the model for decimal degrees
 * instead and every comparison also carries its rounding, which buries a
 * transcription error under a rounding tolerance wide enough to hide one.
 *
 * Fails closed, like everything else here: a notation this tokenizer cannot
 * read, or text carrying anything other than exactly one latitude and one
 * longitude, returns null rather than a best guess.
 */
export function parseVertex(text: string): AreaPoint | null {
  const coords = matchCoordinates(text);
  if (coords.length !== 2) return null;
  const { points, orphans } = pairByHemisphere(coords);
  if (orphans > 0 || points.length !== 1) return null;
  return points[0] ?? null;
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

function ringClosedFor(points: AreaPoint[]): boolean {
  const first = points[0];
  const last = points[points.length - 1];
  return first.lat === last.lat && first.lng === last.lng;
}

/**
 * Parse one statute's markdown into its areas.
 *
 * List items only. There was a second mode that read the `Talva N …
 * Breiddarstig Longdarstig` decimal-degree tables, and it is gone on purpose:
 * in `K 113/2014` those tables are `Skjal 1`, *"Knattstøður fyri verandi
 * fiskileiðir"* — coordinates for EXISTING FISHING GROUNDS, which `§ 6` says
 * bottom fishing outside of needs an exploratory licence. Drawing them as
 * closures closes the open water and opens the closed. All 13 rings parsed
 * perfectly, so no check on the output could have caught it; the tables are
 * shaped identically whether they mean "keep out" or "fish here", and only
 * their prose says which. A tokenizer cannot read prose.
 */
export function extractAreas(content: string): ParsedArea[] {
  const areas: ParsedArea[] = [];
  for (const block of splitBlocks(content)) {
    const items: string[] = [];
    let ambiguous = 0;
    for (const line of block.split("\n")) {
      const item = ITEM_RE.exec(line);
      if (item != null) items.push(item[1]);
      if (isAmbiguousVertexHeading(line)) ambiguous += 1;
    }
    const vertexText = items.filter(isVertexItem);
    const coords = vertexText.flatMap(matchCoordinates);
    // Vertex lines the tokenizer could not read, plus lines whose segmentation
    // is undecidable — both mean this ring is not safe to draw.
    const unparsed =
      items.filter((item) => !isVertexItem(item) && looksLikeVertexItem(item))
        .length + ambiguous;
    if (coords.length < 3) continue;

    const descriptorCount = matchCoordinates(block).length - coords.length;
    const { points, orphans } = pairByHemisphere(coords);
    if (points.length < 3) continue;

    areas.push({
      name: nameOf(block),
      points,
      descriptorCount,
      ringClosed: ringClosedFor(points),
      descriptive: orphans > 0,
      unparsed,
    });
  }
  return areas;
}

/**
 * Is this ONE area safe to draw?
 *
 * Fails CLOSED: an area is withheld when its boundary was described rather than
 * enumerated (`descriptive`), and equally when any of its vertex lines could not
 * be read (`unparsed`). The second case is the one that matters — a ring quietly
 * missing corners still draws, just in the wrong place, which is the failure
 * this ingest exists to end. An honest gap beats a wrong polygon.
 *
 * Exported because the corpus sweep needs both halves of the split — the rings
 * it may draw AND the count it had to withhold — from a SINGLE `extractAreas`
 * pass over 7,405 fragments. A second copy of this predicate at the call site is
 * how "drawable" quietly comes to mean two different things.
 */
export function isDrawable(area: ParsedArea): boolean {
  return !area.descriptive && area.unparsed === 0;
}

/**
 * Areas safe to draw FROM THIS ONE STATUTE.
 *
 * Does NOT resolve supersession — the projector does. A statute whose body still
 * carries superseded list-item rings alongside an in-force replacement table
 * (K 113/2014 with K 102/2024's annex) yields BOTH here, by design, because the
 * `fishfacts-announcement.0` event stays a faithful record of the source. Never
 * treat this output as already merged or in-force-filtered.
 */
export function drawableAreas(content: string): ParsedArea[] {
  return extractAreas(content).filter(isDrawable);
}
