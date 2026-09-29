import type { OfficialClosure, OfficialVertex } from "./fiskeridir-wfs";

/**
 * Comparing what we read out of a J-melding against what Fiskeridirektoratet
 * publishes for the same announcement.
 *
 * This is deliberately a comparison of VERTEX SETS, not of shapes. The
 * authority's drawable polygon is clipped to the coastline and can carry six
 * figures of vertices; `geom_original` is the statute's own list, which is what
 * our coordinate grammar reconstructs. Agreement here means we read the statute
 * correctly. It says nothing about whether the closure is drawable from those
 * vertices — several are bounded by open lines plus the coast, and no text
 * parser can close those.
 */

/** Two vertices are the same position within ~11 m. */
const POSITION_EPSILON_DEG = 0.0001;

export type ParsedArea = {
  name: string | null;
  points: { lat: number; lon: number }[];
};

export type AreaDivergence = {
  paragraph: number | null;
  officialName: string | null;
  ourName: string | null;
  kind:
    | "vertex-count"
    | "position"
    | "unreadable-source"
    | "missing-area"
    | "unnumbered-area";
  detail: string;
};

export type CaseDivergence = {
  jmNumber: string;
  officialAreas: number;
  ourAreas: number;
  /** Set when the counts disagree — the areas are then not compared pairwise. */
  areaCountDetail: string | null;
  areas: AreaDivergence[];
};

function samePosition(a: OfficialVertex, b: { lat: number; lon: number }) {
  return (
    Math.abs(a.lat - b.lat) < POSITION_EPSILON_DEG &&
    Math.abs(a.lon - b.lon) < POSITION_EPSILON_DEG
  );
}

function formatVertex(v: { lat: number; lon: number }) {
  return `${v.lat.toFixed(5)},${v.lon.toFixed(5)}`;
}

/**
 * Official closures for one J-melding, in paragraph order. A closure with no
 * paragraph number sorts last and is matched by position alone.
 */
export function orderOfficial(closures: OfficialClosure[]): OfficialClosure[] {
  return [...closures].sort((a, b) => {
    if (a.paragraph === null) return 1;
    if (b.paragraph === null) return -1;
    return a.paragraph - b.paragraph;
  });
}

/**
 * The § number our area name carries, when it has one. Areas read out of a body
 * with no headings are named after their lead-in sentence and have none.
 */
export function paragraphOf(name: string | null): number | null {
  const match = /§\s*(\d+)/.exec(name ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Pair our areas to the authority's by § number, which only works when both
 * sides number every area and neither repeats one.
 *
 * Worth the check because the fallback — pairing by position — cascades: one
 * area missing from the middle shifts every later pair, and each shifted pair
 * reports as a position difference hundreds of kilometres wide. That turns a
 * single finding into a screenful that hides it.
 */
function pairByParagraph(
  official: OfficialClosure[],
  ours: ParsedArea[],
): { byParagraph: Map<number, ParsedArea[]>; unnumbered: number } | null {
  if (official.some((o) => o.paragraph === null)) return null;
  const numbered = ours.flatMap((area) => {
    const paragraph = paragraphOf(area.name);
    return paragraph === null ? [] : [{ paragraph, area }];
  });
  // Areas whose name carries no § are paired with nothing rather than blocking
  // the § pairing for everything else: an unnamed area is itself a defect
  // (before 2026-09, a body's unheaded coordinates all landed in one), and it
  // is reported on its own rather than dragging the rest onto positional
  // pairing.
  if (numbered.length === 0) return null;
  // A § may yield SEVERAL areas — the reader splits at every lead-in and does
  // not judge whether a run continues the previous one, so a paragraph bounded
  // by two separate lines (§ 1 of the seinot forskrift) arrives as two. They
  // are compared against the authority's single list together, in source
  // order; treating a repeated § as unpairable would drop the whole
  // announcement onto positional pairing and lose every real finding in it.
  const byParagraph = new Map<number, ParsedArea[]>();
  for (const { paragraph, area } of numbered) {
    const existing = byParagraph.get(paragraph);
    if (existing) existing.push(area);
    else byParagraph.set(paragraph, [area]);
  }
  return { byParagraph, unnumbered: ours.length - numbered.length };
}

/** Findings for one closure the authority and we both have. */
function compareArea(
  officialArea: OfficialClosure,
  ourArea: ParsedArea,
): AreaDivergence[] {
  const found: AreaDivergence[] = [];
  const base = {
    paragraph: officialArea.paragraph,
    officialName: officialArea.name,
    ourName: ourArea.name,
  };
  if (officialArea.unreadableVertices > 0) {
    found.push({
      ...base,
      kind: "unreadable-source",
      detail: `${officialArea.unreadableVertices} vertex/vertices in the authority's own list could not be read`,
    });
  }
  if (officialArea.vertices.length === 0) return found;

  if (officialArea.vertices.length !== ourArea.points.length) {
    found.push({
      ...base,
      kind: "vertex-count",
      detail: `authority lists ${officialArea.vertices.length} vertices, we read ${ourArea.points.length}`,
    });
    return found;
  }

  for (const ourPoint of ourArea.points) {
    if (officialArea.vertices.some((v) => samePosition(v, ourPoint))) continue;
    const nearest = officialArea.vertices.reduce((best, v) =>
      Math.hypot(v.lat - ourPoint.lat, v.lon - ourPoint.lon) <
      Math.hypot(best.lat - ourPoint.lat, best.lon - ourPoint.lon)
        ? v
        : best,
    );
    found.push({
      ...base,
      kind: "position",
      detail: `we read ${formatVertex(ourPoint)}, the authority's nearest vertex is ${formatVertex(nearest)}`,
    });
    return found;
  }
  return found;
}

export function compareCase(
  jmNumber: string,
  official: OfficialClosure[],
  ours: ParsedArea[],
): CaseDivergence | null {
  const ordered = orderOfficial(official);
  const divergences: AreaDivergence[] = [];

  const paired = pairByParagraph(ordered, ours);
  if (paired) {
    for (const officialArea of ordered) {
      const ourAreas = paired.byParagraph.get(officialArea.paragraph as number);
      if (!ourAreas || ourAreas.length === 0) {
        divergences.push({
          paragraph: officialArea.paragraph,
          officialName: officialArea.name,
          ourName: null,
          kind: "missing-area",
          detail: "the authority publishes this closure, we read none",
        });
        continue;
      }
      divergences.push(
        ...compareArea(officialArea, {
          name: ourAreas[0].name,
          points: ourAreas.flatMap((a) => a.points),
        }),
      );
    }
    if (paired.unnumbered > 0) {
      divergences.push({
        paragraph: null,
        officialName: null,
        ourName: null,
        kind: "unnumbered-area",
        detail: `${paired.unnumbered} area(s) we read carry no § number and could not be matched`,
      });
    }
    if (divergences.length === 0) return null;
    return {
      jmNumber,
      officialAreas: ordered.length,
      ourAreas: ours.length,
      areaCountDetail: null,
      areas: divergences,
    };
  }

  if (ordered.length !== ours.length) {
    // Pairing by position is only meaningful when both sides agree on how many
    // closures the announcement defines. When they do not, that IS the finding
    // — reporting per-area differences on top of it would be noise derived
    // from a bad alignment.
    return {
      jmNumber,
      officialAreas: ordered.length,
      ourAreas: ours.length,
      areaCountDetail: `authority publishes ${ordered.length} closure(s), we read ${ours.length}`,
      areas: [],
    };
  }

  ordered.forEach((officialArea, index) => {
    divergences.push(...compareArea(officialArea, ours[index]));
  });

  if (divergences.length === 0) return null;
  return {
    jmNumber,
    officialAreas: ordered.length,
    ourAreas: ours.length,
    areaCountDetail: null,
    areas: divergences,
  };
}
