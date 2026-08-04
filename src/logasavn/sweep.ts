/**
 * Walk the whole Lógasavn corpus and write down which fragments carry
 * coordinates.
 *
 * That is ALL this does now. It used to feed a review queue that a human
 * approved geometry out of; the geometry now comes from a reader that can
 * understand Faroese law, and this layer's only remaining job is the one no
 * reader can do for itself — **recall**. An expert answers what it is asked and
 * cannot report a statute nobody mentioned, so something has to be able to say
 * "these 300 of the 7,405 are the ones that mention coordinates at all".
 *
 * No title, topic or `authority:` filter. Filters are how holes happen: the
 * original six-statute list came from a title sweep, and a later sweep still
 * missed `K 193/2017`. Scope by CONTENT — every fragment is read — and use
 * `authority` only to rank the index once it exists (Knowledge `714320cb`).
 *
 * Pure and network-free: the job fetches, this decides. That way the whole
 * classification can be tested against a corpus dump with no Usable token and
 * no database.
 */

import { createHash } from "node:crypto";
import {
  type UsableFragment,
  bodyFromContent,
  frontmatterFromContent,
} from "@/usable/client";
import { extractAreas, isDrawable } from "./areas";
import {
  COORDINATE_TEXT_DETECTOR_ID,
  type CoordinateDetector,
  type DetectableFragment,
  activeDetectors,
  detectCoordinates,
} from "./detection";

/**
 * Printed on EVERY run, not only on failure.
 *
 * `skipped: 3840, processed: 26` turning into `skipped: 3866, processed: 0`
 * means the detector broke, not that the corpus went quiet — and that is only
 * ever visible if the numbers are emitted unconditionally.
 */
export type SweepCounts = {
  scanned: number;
  candidates: number;
  /**
   * Candidates whose statute is currently in force.
   *
   * A COUNT, never a filter — superseded fragments are still swept and still
   * listed, because an index that cannot see them cannot notice one coming
   * back. It is reported separately because it is the number that maps to the
   * census baseline (47), so a drift in it is legible against a figure someone
   * measured by hand.
   */
  inForceCandidates: number;
  skipped: number;
  /** Rings across all candidates that the parser could read. A HINT only. */
  rings: number;
  /** Rings the parser extracted but would not vouch for. */
  withheld: number;
  /** Candidates where coordinates were seen but no ring came out. */
  extractionGaps: number;
  disagreements: number;
};

/**
 * One statute in the index.
 *
 * The counts are **the parser's opinion, and the parser is a witness rather
 * than an author**. It matched a human reading of `K 35/2026` on all ten
 * vertices to twelve decimal places, and it also read thirteen tables of
 * EXISTING FISHING GROUNDS in `K 113/2014` as closures — perfectly, every ring
 * valid. So its numbers are worth publishing next to each statute precisely
 * because a reader who disagrees with them has found something: two
 * independent readings of the same text, where the disagreement is the signal.
 */
export type IndexEntry = {
  fragmentId: string;
  /** sha256 of the statute BODY — frontmatter excluded, see `bodyFromContent`. */
  contentHash: string;
  title: string;
  /** logir.fo permalink. Provenance is not optional — see the plan. */
  url: string | null;
  /** Normalised responsible ministry, for ranking. Never for scope. */
  authority: string | null;
  /** Lógasavn's own `validity_status` (`Galdandi` = in force). */
  validityStatus: string | null;
  /** Coordinate-like constructs the loose detector saw in the body. */
  coordinateSignals: number;
  ringCount: number;
  vertexCount: number;
  withheldCount: number;
  /** The detectors did not agree about this fragment — worth a look. */
  detectorsDisagree: boolean;
};

export type SweepResult = {
  counts: SweepCounts;
  entries: IndexEntry[];
  /** Detectors that fired on nothing corpus-wide, so were not cross-checked. */
  inertDetectors: string[];
};

/** Lógasavn's `validity_status` for a statute that is currently in force. */
export const IN_FORCE = "Galdandi";

/**
 * sha256 over the statute body. Frontmatter is excluded — `bodyFromContent`.
 *
 * Kept through the teardown with a changed job: it no longer pins an approval
 * to an exact text, it tells a reader comparing two versions of the index that
 * a statute was re-scraped since they last read it.
 */
export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Parse the frontmatter here if the caller has not already.
 *
 * `normalizeFragment` fills it in for anything that came through the REST
 * client, so in production this costs nothing. The fallback matters because
 * without it the sweep depends on a step it does not control: hand a raw
 * fragment straight in and `authority` and `validity_status` come back null,
 * silently, with an index that looks fine and cannot be ranked.
 */
function frontmatterOf(fragment: UsableFragment) {
  return fragment.frontmatter ?? frontmatterFromContent(fragment.content);
}

function stringField(
  frontmatter: ReturnType<typeof frontmatterOf>,
  field: string,
): string | null {
  const raw = frontmatter?.[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The responsible ministry, preferring the TAG over the frontmatter field.
 *
 * The tag is normalised to the currently responsible ministry while the
 * frontmatter names the historical signatory — K 164/2020 is signed
 * "Fiskimálaráðið" and K 2/2024 "Fiskivinnu- og samferðslumálaráðið", yet both
 * carry `authority:uttanrikis-og-fiskimalaradid`. Ranking wants the normalised
 * one, because it survives the ministry mergers the raw name does not.
 */
function authorityOf(fragment: UsableFragment): string | null {
  for (const tag of fragment.tags ?? []) {
    const match = /^authority:(.+)$/.exec(tag);
    // `eingin` ("none") is what superseded fragments carry — it names no
    // ministry, so fall through to whoever actually signed the statute.
    if (match?.[1] && match[1] !== "eingin") return match[1];
  }
  return stringField(frontmatterOf(fragment), "authority");
}

function toDetectable(fragment: UsableFragment): DetectableFragment {
  return {
    id: fragment.id,
    body: bodyFromContent(fragment.content),
    tags: fragment.tags ?? [],
  };
}

/**
 * Classify one corpus dump.
 *
 * The parse runs ONCE per candidate and the ring/withheld split comes from
 * filtering that one result, because the corpus is ~99 MB and a second
 * `drawableAreas` pass would double the work to recompute a number we already
 * hold.
 */
export function sweepCorpus(
  fragments: UsableFragment[],
  detectors: CoordinateDetector[],
): SweepResult {
  const detectable = fragments.map(toDetectable);
  const { active, inert } = activeDetectors(detectors, detectable);

  const entries: IndexEntry[] = [];
  const counts: SweepCounts = {
    scanned: 0,
    candidates: 0,
    inForceCandidates: 0,
    skipped: 0,
    rings: 0,
    withheld: 0,
    extractionGaps: 0,
    disagreements: 0,
  };

  for (const [index, fragment] of fragments.entries()) {
    const subject = detectable[index] as DetectableFragment;
    counts.scanned += 1;

    const detection = detectCoordinates(active, subject);
    if (!detection.candidate) {
      counts.skipped += 1;
      continue;
    }

    const areas = extractAreas(subject.body);
    const readable = areas.filter(isDrawable);
    const ringCount = readable.length;
    const vertexCount = readable.reduce(
      (total, area) => total + area.points.length,
      0,
    );
    const withheldCount = areas.length - ringCount;
    const coordinateSignals =
      detection.signals[COORDINATE_TEXT_DETECTOR_ID] ?? 0;
    const frontmatter = frontmatterOf(fragment);
    const validityStatus = stringField(frontmatter, "validity_status");

    counts.candidates += 1;
    if (validityStatus === IN_FORCE) counts.inForceCandidates += 1;
    counts.rings += ringCount;
    counts.withheld += withheldCount;
    if (detection.disagreement) counts.disagreements += 1;
    if (withheldCount > 0 || (coordinateSignals > 0 && ringCount === 0)) {
      counts.extractionGaps += 1;
    }

    entries.push({
      fragmentId: fragment.id,
      contentHash: hashBody(subject.body),
      title: fragment.title ?? "",
      url: stringField(frontmatter, "url"),
      authority: authorityOf(fragment),
      validityStatus,
      coordinateSignals,
      ringCount,
      vertexCount,
      withheldCount,
      detectorsDisagree: detection.disagreement,
    });
  }

  return { counts, entries, inertDetectors: inert };
}

/**
 * Why a sweep must not be published.
 *
 * A corpus that is read successfully but yields NO candidate is not a quiet
 * corpus — 47 in-force fragments carry coordinates and that number only grows.
 * It is the signature of a broken detector, and publishing it would replace a
 * working index with an empty one that still LOOKS authoritative, complete with
 * a fresh timestamp. A stale index is bad; a confidently empty one is worse.
 *
 * So the sweep refuses to land instead of writing its own emptiness. Same
 * fail-closed reflex as the parser's quarantine, one level up.
 */
export function rejectSweep(result: SweepResult): string | null {
  if (result.counts.scanned === 0) {
    return "swept 0 fragments — the corpus fetch returned nothing";
  }
  if (result.counts.candidates === 0) {
    return `swept ${result.counts.scanned} fragments and found 0 coordinate candidates — the detector is broken, not the corpus`;
  }
  return null;
}

/** One line, emitted every run, whatever happened. */
export function formatSweepCounts(result: SweepResult): string {
  const { counts } = result;
  const inert =
    result.inertDetectors.length > 0
      ? `, inert detectors: ${result.inertDetectors.join(", ")}`
      : "";
  return (
    `scanned: ${counts.scanned}, candidates: ${counts.candidates} ` +
    `(${counts.inForceCandidates} in force), ` +
    `skipped: ${counts.skipped}, rings read: ${counts.rings}, ` +
    `withheld: ${counts.withheld}, extraction gaps: ${counts.extractionGaps}, ` +
    `disagreements: ${counts.disagreements}${inert}`
  );
}
