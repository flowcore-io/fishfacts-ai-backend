import type { Env } from "@/env";
import {
  coordinateTextDetector,
  hasCoordinatesTagDetector,
} from "@/logasavn/detection";
import { buildIndexFragment } from "@/logasavn/index-fragment";
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
 * 🇫🇴 Lógasavn corpus sweep — the index of statutes that mention coordinates.
 *
 * Reads every fragment in the Faroese law corpus, asks "could this contain
 * geometry?", and publishes the answer as one fragment in the workspace the
 * chat bot already searches. It draws nothing, approves nothing and decides
 * nothing about what any statute MEANS; that reading is done by whoever opens
 * the index (see the skill, `63652773`).
 *
 * The corpus is read whole (~15 requests, ~30 s, ~99 MB) because list rows
 * carry `content` — there is no per-fragment fetch to amortise, and reading
 * everything is the point. A filtered sweep is how the original six-statute
 * list came to be missing `K 193/2017`.
 *
 * Lógasavn is READ-ONLY for us: this job never writes, retags or corrects a
 * single fragment there. The index it writes lands in Fishfacts Knowledge
 * (`USABLE_WORKSPACE_ID`), a different workspace entirely.
 */
export function createLogasavnSweepJob(env: Env, usable: UsableApiClient) {
  return async function runLogasavnSweepJob(
    _previous: JobState | undefined,
    args: { dryRun?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();

    context.reportProgress({
      phase: "loading-corpus",
      message: "Paging the Lógasavn corpus",
    });
    const fragments = await usable.listFragments({
      workspaceId: env.LOGASAVN_WORKSPACE_ID,
      fragmentTypeId: env.LOGASAVN_FRAGMENT_TYPE_ID,
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
      throw new Error(`Refusing to publish the index — ${rejection}`);
    }

    if (args.dryRun) {
      return {
        checkedAt,
        changed: false,
        latestItems: [],
        message: `Dry run — ${counts}`,
      };
    }

    const page = buildIndexFragment(result, checkedAt);
    context.reportProgress({
      phase: "publishing-index",
      message: `Publishing ${result.entries.length} candidates as ${page.key}`,
      detailsProcessed: result.entries.length,
      detailsTotal: result.entries.length,
    });

    const patch = {
      fragmentTypeId: env.LOGASAVN_INDEX_FRAGMENT_TYPE_ID,
      title: page.title,
      summary: page.summary,
      content: page.content,
      tags: page.tags,
    };
    const existing = await usable.getFragmentByKey(
      env.USABLE_WORKSPACE_ID,
      page.key,
    );
    // Rewritten in place rather than appended to, so there is exactly one index
    // and no way to read a superseded copy of it. Usable keeps the versions.
    const mode = existing ? "updated" : "created";
    if (existing) {
      await usable.updateFragment(existing.id, patch);
    } else {
      await usable.createFragment({
        workspaceId: env.USABLE_WORKSPACE_ID,
        key: page.key,
        ...patch,
      });
    }

    return {
      checkedAt,
      changed: true,
      latestItems: [],
      message: `${counts}; index ${mode} as ${page.key}`,
    };
  };
}
