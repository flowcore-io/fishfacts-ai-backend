/**
 * "Could this fragment contain geometry?" — asked behind a swappable interface.
 *
 * Today the only answer comes from reading the text (`countCoordinateLike`).
 * Jaspur's ingest is being asked upstream to publish a `has_coordinates` tag
 * (task `c0bca131`), which would answer the same question from metadata. The
 * point of the interface is that both can run at once during the transition:
 * two INDEPENDENT readings of the same question, where a disagreement is itself
 * a finding — a tagged fragment we cannot see coordinates in means our
 * tokenizer is blind to a notation, and an untagged fragment full of
 * coordinates means their tagger is.
 *
 * Detection deliberately fails OPEN — anything that might carry geometry
 * becomes a review candidate. Nothing is drawn off the back of it; that gate is
 * `review_status`, and it fails closed.
 */

import { countCoordinateLike } from "./areas";

export type DetectableFragment = {
  id: string;
  /** Statute text with the YAML frontmatter stripped — see `bodyFromContent`. */
  body: string;
  tags: string[];
};

export type DetectorVerdict = {
  detectorId: string;
  candidate: boolean;
  /**
   * How hard the detector fired — coordinate count for the text reader, 1/0 for
   * a tag. Recorded per row so a reviewer can see "47 coordinate-like
   * constructs, 0 rings" without re-running anything.
   */
  signal: number;
};

export type CoordinateDetector = {
  id: string;
  detect: (fragment: DetectableFragment) => DetectorVerdict;
};

export const COORDINATE_TEXT_DETECTOR_ID = "coordinate-text";
export const HAS_COORDINATES_TAG_DETECTOR_ID = "has-coordinates-tag";

/**
 * Reads the statute text with the same over-triggering detector the parser's
 * quarantine uses. Asking the question with a DIFFERENT regex than the one
 * `unparsed` is computed from is how fragments fall through the gap between
 * "not a candidate" and "candidate we failed to parse".
 */
export const coordinateTextDetector: CoordinateDetector = {
  id: COORDINATE_TEXT_DETECTOR_ID,
  detect(fragment) {
    const signal = countCoordinateLike(fragment.body);
    return {
      detectorId: COORDINATE_TEXT_DETECTOR_ID,
      candidate: signal > 0,
      signal,
    };
  },
};

// Both spellings are accepted because we do not own the tag: it is proposed
// upstream, and guessing wrong on the separator would make the detector
// silently inert forever rather than visibly absent (see `activeDetectors`).
const HAS_COORDINATES_TAGS = new Set(["has_coordinates", "has-coordinates"]);

export const hasCoordinatesTagDetector: CoordinateDetector = {
  id: HAS_COORDINATES_TAG_DETECTOR_ID,
  detect(fragment) {
    const candidate = fragment.tags.some((tag) =>
      HAS_COORDINATES_TAGS.has(tag),
    );
    return {
      detectorId: HAS_COORDINATES_TAG_DETECTOR_ID,
      candidate,
      signal: candidate ? 1 : 0,
    };
  },
};

export type Detection = {
  candidate: boolean;
  /** The detectors did not agree — a finding in its own right. */
  disagreement: boolean;
  verdicts: DetectorVerdict[];
  signals: Record<string, number>;
};

/**
 * Did the readers differ about this fragment?
 *
 * Derived from the stored verdicts rather than persisted alongside them, so a
 * review row cannot end up claiming agreement that its own detector record
 * contradicts. One reader never disagrees with itself.
 */
export function detectorsDisagree(verdicts: DetectorVerdict[]): boolean {
  const first = verdicts[0];
  if (first == null) return false;
  return verdicts.some((verdict) => verdict.candidate !== first.candidate);
}

/**
 * Ask every detector, and take the UNION.
 *
 * Union rather than intersection because the sweep's job is recall: a candidate
 * only costs a reviewer a glance, while a missed statute is a closure that
 * never gets drawn and that nothing reports on.
 */
export function detectCoordinates(
  detectors: CoordinateDetector[],
  fragment: DetectableFragment,
): Detection {
  const verdicts = detectors.map((detector) => detector.detect(fragment));
  const signals: Record<string, number> = {};
  for (const verdict of verdicts) signals[verdict.detectorId] = verdict.signal;
  return {
    candidate: verdicts.some((verdict) => verdict.candidate),
    disagreement: detectorsDisagree(verdicts),
    verdicts,
    signals,
  };
}

/**
 * Drop detectors that fire on NOTHING in the whole corpus.
 *
 * A detector reading a tag that has not shipped yet is absent, not dissenting.
 * Left in, it would disagree with the text reader on every single candidate and
 * stamp the entire queue `crosscheck_disagreement` on day one — burying the
 * handful of real disagreements it exists to surface, and doing it during
 * precisely the transition window the cross-check was built for.
 *
 * Corpus-wide silence is the right test rather than a config flag: the day
 * Jaspur ships the tag, the cross-check turns itself on.
 */
export function activeDetectors(
  detectors: CoordinateDetector[],
  fragments: DetectableFragment[],
): { active: CoordinateDetector[]; inert: string[] } {
  const active: CoordinateDetector[] = [];
  const inert: string[] = [];
  for (const detector of detectors) {
    if (fragments.some((fragment) => detector.detect(fragment).candidate)) {
      active.push(detector);
    } else {
      inert.push(detector.id);
    }
  }
  // An empty corpus silences everything; keep the set intact so a failed fetch
  // reads as "swept nothing" rather than "the detectors are all gone".
  return active.length > 0
    ? { active, inert }
    : { active: detectors, inert: [] };
}
