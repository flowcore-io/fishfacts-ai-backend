import type { Env } from "@/env";
import {
  coordinateTextDetector,
  hasCoordinatesTagDetector,
} from "@/logasavn/detection";
import { mergeReviewRows } from "@/logasavn/review";
import type { LogasavnReviewRepository } from "@/logasavn/review-repository";
import { formatSweepCounts, rejectSweep, sweepCorpus } from "@/logasavn/sweep";
import type { UsableApiClient } from "@/usable/client";
import type { JobExecutionResult, JobState } from "./types";

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    itemsDiscovered?: number;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/**
 * Both detectors run on every sweep. The tag one is inert until Jaspur's ingest
 * ships `has_coordinates` (task `c0bca131`), and says so in the run message
 * rather than quietly disagreeing with the text reader 47 times — see
 * `activeDetectors`.
 */
const DETECTORS = [coordinateTextDetector, hasCoordinatesTagDetector];

/**
 * 🇫🇴 Lógasavn corpus sweep — the drift watchdog and the review queue's feeder.
 *
 * Reads every fragment in the Faroese law corpus, asks "could this contain
 * geometry?", and lands each candidate in `logasavn_review` as **pending**.
 * Nothing here draws anything: approval is a human act, and until it happens
 * the answer is no.
 *
 * The corpus is read whole (~15 requests, ~30 s, ~99 MB) because list rows
 * carry `content` — there is no per-fragment fetch to amortise, and reading
 * everything is the point. A filtered sweep is how the original six-statute
 * list came to be missing `K 193/2017`.
 *
 * Lógasavn is READ-ONLY for us: this job never writes, retags or corrects a
 * single fragment there.
 */
export function createLogasavnSweepJob(
  env: Env,
  usable: UsableApiClient,
  reviewRepository: LogasavnReviewRepository,
) {
  return async function runLogasavnSweepJob(
    _previous: JobState | undefined,
    args: { dryRun?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const workspaceId = env.LOGASAVN_WORKSPACE_ID;
    const fragmentTypeId = env.LOGASAVN_FRAGMENT_TYPE_ID;

    context.reportProgress({
      phase: "loading-corpus",
      message: "Paging the Lógasavn corpus",
    });
    const fragments = await usable.listFragments({
      workspaceId,
      fragmentTypeId,
    });

    if (context.signal.aborted || context.isStopRequested()) {
      throw new Error("Job stopped by request");
    }

    context.reportProgress({
      phase: "detecting",
      message: `Scanning ${fragments.length} fragments for coordinates`,
      itemsDiscovered: fragments.length,
    });
    const result = sweepCorpus(fragments, DETECTORS);
    const counts = formatSweepCounts(result);
    // Unconditional: the counts are the instrument, and an instrument that only
    // reports when it is unhappy cannot show you the day it stopped working.
    console.info("[LogasavnSweep]", counts);

    const rejection = rejectSweep(result);
    if (rejection) {
      throw new Error(`Refusing to write review state — ${rejection}`);
    }

    if (args.dryRun) {
      return {
        checkedAt,
        changed: false,
        latestItems: [],
        message: `Dry run — ${counts}`,
      };
    }

    context.reportProgress({
      phase: "merging-review-state",
      message: `Merging ${result.observed.length} candidates into the review queue`,
      detailsProcessed: result.observed.length,
      detailsTotal: result.observed.length,
    });
    const existing = await reviewRepository.loadAll();
    const merged = mergeReviewRows(existing, result, checkedAt);
    await reviewRepository.apply(merged);

    const pending = merged.filter(
      (row) => row.isCurrent && row.reviewStatus === "pending",
    ).length;
    const reopened = merged.filter(
      (row) =>
        row.isCurrent &&
        row.reviewReason === "source_changed" &&
        row.firstSeenAt === checkedAt,
    ).length;

    // Named rather than inlined: a statute whose text moved under an approval
    // is the one line of this message someone needs to act on.
    const drift =
      reopened > 0 ? `, ${reopened} re-opened by a source change` : "";

    return {
      checkedAt,
      changed: reopened > 0 || merged.length !== existing.length,
      latestItems: [],
      message: `${counts}; ${pending} awaiting review${drift}`,
    };
  };
}
