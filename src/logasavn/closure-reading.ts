/**
 * Two independent readings of one statute, and the gate between them.
 *
 * An LLM reads the statute and says what each ring MEANS — which `§` it sits
 * in, whether it closes water or exempts water inside a closure, whether it is
 * seasonal. That is the half no regex can do: `K 113/2014`'s Skjal 1 tables
 * parsed perfectly and meant the opposite of what the pipeline recorded, and
 * `K 30/2018` yields `A`/`a`, `D`/`d`, `F`/`f` where the lowercase ring is an
 * exemption INSIDE the closure of the same letter. Drawing those closes open
 * water.
 *
 * But the LLM also emits several hundred vertices per run, and that is the one
 * step whose errors are silent — a ring with one corner in the wrong place
 * still draws, and looks right. `extractAreas` is an independent reader of the
 * same text, it is already here, and it costs microseconds. So it runs too, and
 * a ring the two disagree about is WITHHELD rather than reconciled.
 *
 * The comparison is arranged so that it tests transcription and nothing else:
 * the model is asked to quote each vertex in the statute's own notation, and
 * both sides then go through `parseVertex` — the same tokenizer, the same
 * arithmetic. See `VERTEX_TOLERANCE_DEGREES` for why that matters.
 *
 * Pure and network-free. The job fetches and calls the model; this decides what
 * survives.
 */

import {
  type AreaPoint,
  type ParsedArea,
  isDrawable,
  parseVertex,
} from "./areas";

/**
 * What one ring of a statute is FOR.
 *
 * `exemption` is not a synonym for "not a closure" — it is water inside a
 * closure that the same statute reopens, and it exists because `K 30/2018 § 5,
 * stk. 2` opens `øki a` from 1 September to 31 May inside the year-round
 * closure `Øki A`. `other` covers everything that is neither: fishing-ground
 * tables, territorial baselines, the permit regime in `K 35/2026`.
 *
 * Only `closure` is ever drawn.
 */
export type RingKind = "closure" | "exemption" | "other";

/** One vertex, quoted from the statute rather than converted. */
export type VertexQuote = { lat: string; lon: string };

export type RingReading = {
  /** Where it lives, as the statute writes it: `"§ 5, stk. 1"`. */
  section: string;
  /**
   * The statute's own name for the area (`Øki A`, `a`, `HAR 1`), VERBATIM.
   *
   * Case is semantic and must survive: upper-casing merges `Øki A` with its own
   * exemption `øki a`. Same trap as `nameOf` in the parser, one layer up.
   */
  name: string | null;
  kind: RingKind;
  /** The season as printed (`"1. september – 31. mai"`), or null if year-round. */
  season: string | null;
  vertices: VertexQuote[];
};

export type StatuteReading = {
  /** The model's own reading of validity, cross-checked against frontmatter. */
  inForce: boolean;
  /** One plain-language line, for the map popup. */
  summary: string;
  rings: RingReading[];
};

export type AgreedRing = {
  reading: RingReading;
  /** The vertices both readers arrived at, ready to emit. */
  points: AreaPoint[];
};

/**
 * Why a ring is not being drawn.
 *
 * `unreadable-quote` and `no-parser-counterpart` are failures of the gate.
 * `not-a-closure` is not a failure at all — it is the gate working, and it is
 * counted separately so that a run which correctly declines 13 fishing-ground
 * tables does not read as a run that broke.
 */
export type WithholdReason =
  | "unreadable-quote"
  | "no-parser-counterpart"
  | "not-a-closure";

export type WithheldRing = {
  reading: RingReading;
  reason: WithholdReason;
  detail: string;
};

export type ComparisonResult = {
  agreed: AgreedRing[];
  withheld: WithheldRing[];
  /**
   * Rings the PARSER read and would vouch for, that the model's reading did not
   * account for at all.
   *
   * Never drawn — the parser is a witness, not an author, and a ring nobody
   * could say the meaning of is exactly what must not reach a chart. It is
   * surfaced because it is the one signal that the model skipped part of a
   * statute, which is the failure mode ingest exists to remove and would
   * otherwise be invisible: withheld rings are loud, unread ones are silent.
   */
  unclaimed: ParsedArea[];
};

/**
 * How close two readings of the same vertex must be, in degrees.
 *
 * 1e-9° is about a tenth of a millimetre, which looks absurd until you notice
 * what is being compared. Both sides ran `parseVertex` over text in the
 * statute's own notation, so identical readings produce IDENTICAL floats and the
 * tolerance exists only to absorb float association. Any gap wider than this is
 * a difference about what the statute says, not about arithmetic.
 *
 * The alternative — asking the model for decimal degrees — needs a tolerance
 * wide enough for its rounding, and the error this gate exists to catch fits
 * comfortably underneath one. A dropped fractional second (`65° 41′ 22.63″ N`
 * read as `22″`) moves a vertex 19 metres, which is 1.7e-4°; a tolerance loose
 * enough to accept six-decimal rounding is already a third of the way there,
 * and nothing downstream can see the difference.
 */
export const VERTEX_TOLERANCE_DEGREES = 1e-9;

function samePoint(a: AreaPoint, b: AreaPoint): boolean {
  return (
    Math.abs(a.lat - b.lat) <= VERTEX_TOLERANCE_DEGREES &&
    Math.abs(a.lng - b.lng) <= VERTEX_TOLERANCE_DEGREES
  );
}

/**
 * Drop the repeated first vertex some rings carry and others do not.
 *
 * Statutes close a ring by listing the opening vertex again; whether a given
 * reader keeps that duplicate is a formatting choice, not a disagreement. Every
 * count difference in the one measured comparison — 13 model-drawn rings against
 * the statute text — was exactly this.
 */
function withoutClosingDuplicate(points: AreaPoint[]): AreaPoint[] {
  if (points.length < 2) return points;
  const first = points[0] as AreaPoint;
  const last = points[points.length - 1] as AreaPoint;
  return samePoint(first, last) ? points.slice(0, -1) : points;
}

/**
 * Do these two rings describe the same shape?
 *
 * Order matters and is NOT normalised. A ring rotated to a different starting
 * vertex, or listed backwards, covers the same water — and accepting either
 * would also accept a model that reordered the statute's list, which is a
 * documented failure mode under retry pressure (`194bd8af`, rule 5: a re-ordered
 * chord ring passes a shape check and still cuts across land). Two readers
 * quoting the same numbered list have no reason to disagree about its order, so
 * a disagreement about order is a finding, not a formatting difference.
 */
function sameRing(a: AreaPoint[], b: AreaPoint[]): boolean {
  const left = withoutClosingDuplicate(a);
  const right = withoutClosingDuplicate(b);
  if (left.length !== right.length) return false;
  return left.every((point, index) =>
    samePoint(point, right[index] as AreaPoint),
  );
}

/**
 * Turn the model's quotes into points, or say which quote defeated us.
 *
 * A quote the tokenizer cannot read is not rounded off or skipped: one missing
 * vertex leaves a ring that still draws, with a corner in the wrong place.
 */
function pointsFromQuotes(
  vertices: VertexQuote[],
): { points: AreaPoint[] } | { unreadable: VertexQuote } {
  const points: AreaPoint[] = [];
  for (const quote of vertices) {
    const point = parseVertex(`${quote.lat} ${quote.lon}`);
    if (point == null) return { unreadable: quote };
    points.push(point);
  }
  return { points };
}

/**
 * Run the gate over one statute.
 *
 * `areas` is the parser's whole output; only the rings it would vouch for
 * (`isDrawable`) count as corroboration. A ring the parser itself withheld is
 * not a second reading — it is an abstention, and treating it as agreement
 * would leave the model's vertices unchecked precisely where the text is
 * hardest to read.
 */
export function compareReading(
  reading: StatuteReading,
  areas: ParsedArea[],
): ComparisonResult {
  const witnesses = areas.filter(isDrawable);
  const claimed = new Set<number>();
  const agreed: AgreedRing[] = [];
  const withheld: WithheldRing[] = [];

  for (const ring of reading.rings) {
    const read = pointsFromQuotes(ring.vertices);
    if ("unreadable" in read) {
      withheld.push({
        reading: ring,
        reason: "unreadable-quote",
        detail: `cannot read "${read.unreadable.lat} ${read.unreadable.lon}" as a coordinate`,
      });
      continue;
    }

    const match = witnesses.findIndex(
      (area, index) =>
        !claimed.has(index) && sameRing(read.points, area.points),
    );
    if (match === -1) {
      withheld.push({
        reading: ring,
        reason: "no-parser-counterpart",
        detail: `${read.points.length} vertices, matching none of the ${witnesses.length} rings the parser read`,
      });
      continue;
    }
    // Claimed even when it is an exemption: the parser DID read this ring, and
    // leaving it unclaimed would report it as geometry nobody accounted for.
    claimed.add(match);

    if (ring.kind !== "closure") {
      withheld.push({
        reading: ring,
        reason: "not-a-closure",
        detail: `read as ${ring.kind}`,
      });
      continue;
    }
    agreed.push({ reading: ring, points: read.points });
  }

  return {
    agreed,
    withheld,
    unclaimed: witnesses.filter((_, index) => !claimed.has(index)),
  };
}

/**
 * The name a drawn ring carries on the map.
 *
 * `areas[].name` already flows from the event through the projector to the
 * shape the user clicks, so putting the section in it is how provenance reaches
 * the popup without a schema change. `"Øki A — § 5, stk. 1"` is checkable
 * against logir.fo; "closure near Føroyabanki" is not, and an error a skipper
 * cannot locate is an error they cannot report.
 */
export function ringLabel(ring: RingReading): string {
  const where = ring.name ? `${ring.name} — ${ring.section}` : ring.section;
  // The season goes in the label because there is nowhere else for it yet:
  // `jmelding_geo` has `valid_from`/`valid_to` for an absolute window and no
  // column for one that recurs every year. Until it does (`7b79fd0f`), a
  // spawning closure that bites for three months would otherwise be drawn
  // exactly like a year-round one, and a skipper reading the map could not tell.
  return ring.season ? `${where} (${ring.season})` : where;
}
