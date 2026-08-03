/**
 * Walk the whole Lógasavn corpus and decide what belongs in the review queue.
 *
 * No title, topic or `authority:` filter. Filters are how holes happen: the
 * original six-statute list came from a title sweep, and a later sweep still
 * missed `K 193/2017`. Scope by CONTENT — every fragment is read — and use
 * `authority` only to rank the queue once it exists (Knowledge `714320cb`).
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
import type { ObservedCandidate } from "./review";

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
   * recorded, because a queue that cannot see them cannot notice one coming
   * back. It is reported separately because it is the number that maps to the
   * census baseline (47) and the number a reviewer actually faces, so a drift
   * in it is legible against a figure someone measured by hand.
   */
  inForceCandidates: number;
  skipped: number;
  /** Rings across all candidates that the parser considers safe to draw. */
  drawable: number;
  /** Areas extracted but withheld as unsafe — the fail-closed quarantine. */
  quarantined: number;
  /** Candidates where coordinates were seen but no ring came out. */
  extractionGaps: number;
  disagreements: number;
};

export type SweepResult = {
  counts: SweepCounts;
  observed: ObservedCandidate[];
  /** Every fragment id this sweep actually read — see `mergeReviewRows`. */
  scannedFragmentIds: Set<string>;
  /** Detectors that fired on nothing corpus-wide, so were not cross-checked. */
  inertDetectors: string[];
};

/** Lógasavn's `validity_status` for a statute that is currently in force. */
export const IN_FORCE = "Galdandi";

/** sha256 over the statute body. Frontmatter is excluded — `bodyFromContent`. */
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
 * silently, with a queue that looks fine and cannot be triaged.
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
 * carry `authority:uttanrikis-og-fiskimalaradid`. Triage wants the normalised
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
 * The parse runs ONCE per candidate and the drawable/withheld split comes from
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

  const observed: ObservedCandidate[] = [];
  const scannedFragmentIds = new Set<string>();
  const counts: SweepCounts = {
    scanned: 0,
    candidates: 0,
    inForceCandidates: 0,
    skipped: 0,
    drawable: 0,
    quarantined: 0,
    extractionGaps: 0,
    disagreements: 0,
  };

  for (const [index, fragment] of fragments.entries()) {
    const subject = detectable[index] as DetectableFragment;
    counts.scanned += 1;
    scannedFragmentIds.add(fragment.id);

    const detection = detectCoordinates(active, subject);
    if (!detection.candidate) {
      counts.skipped += 1;
      continue;
    }

    const areas = extractAreas(subject.body);
    const drawable = areas.filter(isDrawable);
    const ringCount = drawable.length;
    const vertexCount = drawable.reduce(
      (total, area) => total + area.points.length,
      0,
    );
    const withheldCount = areas.length - ringCount;
    const coordinateLike = detection.signals[COORDINATE_TEXT_DETECTOR_ID] ?? 0;
    const validityStatus = stringField(
      frontmatterOf(fragment),
      "validity_status",
    );

    counts.candidates += 1;
    if (validityStatus === IN_FORCE) counts.inForceCandidates += 1;
    counts.drawable += ringCount;
    counts.quarantined += withheldCount;
    if (detection.disagreement) counts.disagreements += 1;
    if (withheldCount > 0 || (coordinateLike > 0 && ringCount === 0)) {
      counts.extractionGaps += 1;
    }

    observed.push({
      fragmentId: fragment.id,
      contentHash: hashBody(subject.body),
      title: fragment.title ?? "",
      authority: authorityOf(fragment),
      validityStatus,
      coordinateLike,
      ringCount,
      vertexCount,
      withheldCount,
      detectors: detection.verdicts,
    });
  }

  return { counts, observed, scannedFragmentIds, inertDetectors: inert };
}

/**
 * Why a sweep must not be written to the review table.
 *
 * A corpus that is read successfully but yields NO candidate is not a quiet
 * corpus — 47 in-force fragments carry coordinates and that number only grows.
 * It is the signature of a broken detector, and it is dangerous rather than
 * merely wrong: with no candidates observed, the merge would correctly conclude
 * that every approved statute has gone dark and retire the lot, turning one
 * regex mistake into a blank regulatory map.
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
    `skipped: ${counts.skipped}, drawable rings: ${counts.drawable}, ` +
    `quarantined: ${counts.quarantined}, extraction gaps: ${counts.extractionGaps}, ` +
    `disagreements: ${counts.disagreements}${inert}`
  );
}
