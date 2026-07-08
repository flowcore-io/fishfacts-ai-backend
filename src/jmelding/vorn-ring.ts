/**
 * Read-model cleanup for Vørn (FO) closure rings.
 *
 * Vørn emergency-ban notices list boundary points as hand-typed text and close
 * every ring by repeating the first vertex as the last. The raw
 * `fishfacts-announcement.0` events faithfully preserve exactly what Vørn
 * published — including the closing duplicate and any coordinate typo — so the
 * source record is never lossy. This module is the transformer step that turns
 * those faithful points into a drawable ring for the read model
 * (`jmelding_geo`), applied by the geo projector.
 *
 * Two clean-ups:
 *  1. Drop the repeated closing vertex (the normal Vørn convention).
 *  2. Recover from a typo'd closing vertex — real case: veiðibann nr. 14/2026,
 *     where the closing "6104 N – 0700 W" was fat-fingered as "6014 N" (a digit
 *     transposition ~93 km too far south), leaving the ring unclosed and
 *     self-intersecting so it rendered as a degenerate shape. When a ring does
 *     not close by repeat AND is self-intersecting AND dropping the offending
 *     final vertex yields a simple polygon, that vertex is treated as a
 *     corrupted closing token and dropped — surfacing a `warning` so the source
 *     typo can be flagged to Vørn.
 *
 * Deliberately conservative: valid concave rings (e.g. nr. 12) are never
 * touched. Because this runs in the projector, replaying the pathway
 * re-derives corrected geometry from the untouched raw events.
 */

export type RingPoint = { lat: number; lon: number };

function fmtPoint(p: RingPoint): string {
  const ns = p.lat >= 0 ? "N" : "S";
  const ew = p.lon >= 0 ? "E" : "W";
  return `${Math.abs(p.lat).toFixed(4)}${ns}, ${Math.abs(p.lon).toFixed(4)}${ew}`;
}

/**
 * Do any two non-adjacent edges of the ring cross? The ring is treated as
 * implicitly closed (last vertex → first vertex), matching how the map draws
 * it. Pure + allocation-light so it can gate the normaliser below.
 */
export function ringSelfIntersects(points: RingPoint[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  const ccw = (a: RingPoint, b: RingPoint, c: RingPoint) =>
    (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
  const crosses = (a: RingPoint, b: RingPoint, c: RingPoint, d: RingPoint) =>
    ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
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
  droppedPoint?: RingPoint;
  firstPoint: RingPoint;
  lastPoint: RingPoint;
};

/**
 * Normalise a single Vørn ring: drop the exact closing duplicate, and — only
 * when a ring is genuinely broken (doesn't close by repeat AND self-intersects
 * AND dropping the offending vertex yields a simple polygon) — drop the
 * corrupted closing token, returning a `warning`. Valid rings pass through.
 */
export function normalizeVornRing(raw: RingPoint[]): {
  points: RingPoint[];
  warning: RingNormalization | null;
} {
  const points = [...raw];
  if (points.length <= 2) return { points, warning: null };
  const first = points[0];
  const last = points[points.length - 1];
  const closesByRepeat = first.lat === last.lat && first.lon === last.lon;
  if (closesByRepeat) {
    points.pop();
    return { points, warning: null };
  }
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

export type NormalizableArea = { name?: string | null; points: RingPoint[] };

/**
 * Apply {@link normalizeVornRing} to every area of a Vørn (FO) announcement,
 * collecting any warnings for the caller to log. Pure — the projector wires the
 * logging + persistence around it.
 */
export function normalizeVornAreas<A extends NormalizableArea>(
  areas: A[],
): { areas: A[]; warnings: RingNormalization[] } {
  const warnings: RingNormalization[] = [];
  const out = areas.map((area) => {
    const { points, warning } = normalizeVornRing(area.points);
    if (warning) warnings.push(warning);
    return { ...area, points };
  });
  return { areas: out, warnings };
}
