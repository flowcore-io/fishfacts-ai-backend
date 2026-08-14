/**
 * Fishing-speed segmentation of an AIS track.
 *
 * A vessel that is working slows into the fishing-speed band and stays there
 * for a while; the tight loop cluster it leaves behind is where the fish came
 * from. This module turns a stream of position fixes into the contiguous runs
 * that qualify as "actually fishing", each with its centroid — the derived
 * catch position the Sildelaget bubble layer is placed on.
 *
 * It is the server-side twin of fishfacts-fe
 * `src/store/map/sildelagetCatch/sildelagetAisAnchor.ts`. The two must agree
 * fix-for-fix, so every threshold below is a single named constant and the
 * band predicate is one exported function (see isFishingSpeed).
 */

/**
 * House fishing-speed band, in knots. THE definition — `/api/ais/effort`'s
 * defaults (ais/routes.ts) and the Sildelaget derived catch positions both
 * read these constants rather than restating the numbers. A second hardcoded
 * pair anywhere is a silent data defect: nothing fails, the two endpoints just
 * quietly answer different questions.
 *
 * PRD OQ9 is open with Jón Poulsen over whether below 1 kn (pumping or
 * drifting, as against towing) belongs in the band at all, so the low end is
 * expected to move — hence AIS_FISHING_*_KNOTS_ENV overrides in env.ts.
 */
export const AIS_FISHING_MIN_KNOTS = 0.3;
export const AIS_FISHING_MAX_KNOTS = 5.5;

/**
 * A coverage gap longer than this ends a run. An AIS hole is not evidence of
 * fishing, so a run is never bridged across one (mirrors /api/ais/effort,
 * which discards over-gap deltas rather than crediting them as effort).
 */
export const AIS_RUN_MAX_GAP_MINUTES = 30;

/** Anything shorter than this (fixes or minutes) is a momentary slowdown. */
export const AIS_RUN_MIN_FIXES = 3;
export const AIS_RUN_MIN_MINUTES = 15;

/** One position fix, as the run walker needs it. */
export type AisRunFix = {
  /** Fix time, epoch ms. */
  epochMs: number;
  latitude: number;
  longitude: number;
  /**
   * Speed over ground in knots, or null when the fix carried none. NEVER
   * coerce this to 0 — see isFishingSpeed.
   */
  speed: number | null;
};

/** One contiguous fishing-speed run, anchored at its centroid. */
export type AisFishingRun = {
  /** Centroid of the run's fixes. */
  latitude: number;
  longitude: number;
  /**
   * Fixes in the run. Every one of them has a finite speed (a fix without one
   * cannot pass isFishingSpeed), so avgKnots is the mean over exactly these
   * fixes — no fix is silently missing from it.
   */
  fixCount: number;
  runStart: string;
  runEnd: string;
  avgKnots: number;
};

export type FishingBand = {
  minKnots: number;
  maxKnots: number;
};

export type FishingRunThresholds = FishingBand & {
  maxGapMinutes: number;
  minRunFixes: number;
  minRunMinutes: number;
};

export const DEFAULT_FISHING_RUN_THRESHOLDS: FishingRunThresholds = {
  minKnots: AIS_FISHING_MIN_KNOTS,
  maxKnots: AIS_FISHING_MAX_KNOTS,
  maxGapMinutes: AIS_RUN_MAX_GAP_MINUTES,
  minRunFixes: AIS_RUN_MIN_FIXES,
  minRunMinutes: AIS_RUN_MIN_MINUTES,
};

/**
 * Is this fix inside the fishing-speed band?
 *
 * BOUNDARY SEMANTICS — INCLUSIVE AT BOTH ENDS: `speed >= min && speed <= max`.
 * Stated here explicitly because fishfacts-fe carries the same predicate and a
 * `>` / `>=` drift between the two repos survives both code reviews and shows
 * up only as wrong positions: 0.3 and 5.5 are IN the band on both sides.
 * (/api/ais/effort's SQL agrees — `speed >= {minKn} AND speed <= {maxKn}`.)
 *
 * A missing or non-finite speed is MISSING, not zero: it fails the test, which
 * ends any run in progress, because "we do not know what this fix was" is not
 * evidence of fishing. Coercing it to 0 would happen to give the same answer
 * here (0 is below the floor) but would poison the run averages downstream, so
 * the unknown is kept unknown at the only place it is tested.
 */
export function isFishingSpeed(
  speed: number | null | undefined,
  band: FishingBand = DEFAULT_FISHING_RUN_THRESHOLDS,
): boolean {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return false;
  return speed >= band.minKnots && speed <= band.maxKnots;
}

/**
 * Every qualifying fishing run in `fixes`, oldest first.
 *
 * A run collects consecutive in-band fixes; it ends when a fix is out of band
 * (or has no speed) or when the step to the next fix exceeds maxGapMinutes.
 * Runs too short to be a real cast/tow are dropped. The FE spike keeps only
 * the last run before the report — that is `deriveFishingRuns(...).at(-1)`,
 * so the two stay reconcilable.
 */
export function deriveFishingRuns(
  fixes: AisRunFix[],
  thresholds: FishingRunThresholds = DEFAULT_FISHING_RUN_THRESHOLDS,
): AisFishingRun[] {
  const maxGapMs = thresholds.maxGapMinutes * 60_000;
  const ordered = fixes
    .filter((fix) => Number.isFinite(fix.epochMs))
    .sort((a, b) => a.epochMs - b.epochMs);

  const runs: AisFishingRun[] = [];
  let current: AisRunFix[] = [];

  const flush = () => {
    const run = qualifyRun(current, thresholds);
    if (run) runs.push(run);
    current = [];
  };

  for (const fix of ordered) {
    if (!isFishingSpeed(fix.speed, thresholds)) {
      flush();
      continue;
    }
    const previous = current.at(-1);
    // A coverage hole ends the run being collected; this fix starts the next
    // one, exactly as the FE does when it breaks a run on gap alone.
    if (previous && fix.epochMs - previous.epochMs > maxGapMs) flush();
    current.push(fix);
  }
  flush();

  return runs;
}

/** Centroid + stats, or null when the run is too short to be a cast/tow. */
function qualifyRun(
  run: AisRunFix[],
  thresholds: FishingRunThresholds,
): AisFishingRun | null {
  if (run.length < thresholds.minRunFixes) return null;
  const first = run[0] as AisRunFix;
  const last = run[run.length - 1] as AisRunFix;
  const durationMinutes = (last.epochMs - first.epochMs) / 60_000;
  if (durationMinutes < thresholds.minRunMinutes) return null;

  // Plain mean of lat/lon — loop clusters are far too small for projection
  // error to matter. (Known limit: a run straddling the ±180° antimeridian
  // would average wrong; no Sildelaget grounds are near it.)
  let latitude = 0;
  let longitude = 0;
  let knots = 0;
  for (const fix of run) {
    latitude += fix.latitude;
    longitude += fix.longitude;
    // Safe by construction: isFishingSpeed rejected every non-finite speed, so
    // no unknown is being averaged in as a number here.
    knots += fix.speed as number;
  }

  return {
    latitude: latitude / run.length,
    longitude: longitude / run.length,
    fixCount: run.length,
    runStart: new Date(first.epochMs).toISOString(),
    runEnd: new Date(last.epochMs).toISOString(),
    avgKnots: Number((knots / run.length).toFixed(1)),
  };
}

/** Great-circle distance in km. */
export function haversineKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(latitudeB - latitudeA);
  const dLon = toRad(longitudeB - longitudeA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latitudeA)) *
      Math.cos(toRad(latitudeB)) *
      Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
