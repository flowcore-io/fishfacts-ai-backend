import { createHash } from "node:crypto";
import type {
  AisFixWindowRequest,
  AisFixWindowRow,
} from "@/ais/clickhouse-repository";
import type { FishingRunThresholds } from "@/ais/fishing-runs";
import type { Env } from "@/env";
import type { VesselDirectory } from "@/fishfacts/vessel-directory";
import type { JobExecutionResult, JobState } from "@/jobs/types";
import {
  type SildelagetAisAnchor,
  anchorWindow,
  deriveSildelagetAisAnchor,
  reportEpochMs,
} from "@/sildelaget/ais-anchor";
import type {
  SildelagetAisAnchorRepository,
  SildelagetAnchorCandidate,
} from "@/sildelaget/ais-anchor-repository";

/** Everything the derivation depends on — hashed into each stored row. */
export type SildelagetAnchorParams = FishingRunThresholds & {
  lookbackHours: number;
  sanityKm: number;
  timeZone: string;
};

export function anchorParamsFromEnv(env: Env): SildelagetAnchorParams {
  return {
    minKnots: env.AIS_FISHING_MIN_KNOTS,
    maxKnots: env.AIS_FISHING_MAX_KNOTS,
    maxGapMinutes: env.AIS_RUN_MAX_GAP_MINUTES,
    minRunFixes: env.AIS_RUN_MIN_FIXES,
    minRunMinutes: env.AIS_RUN_MIN_MINUTES,
    lookbackHours: env.SILDELAGET_AIS_ANCHOR_LOOKBACK_HOURS,
    sanityKm: env.SILDELAGET_AIS_ANCHOR_SANITY_KM,
    timeZone: env.SILDELAGET_JOURNAL_TIME_ZONE,
  };
}

/**
 * Fingerprint of the parameter set a row was derived under. When the band
 * moves (PRD OQ9 is open on the low end), the hash changes and every affected
 * row is recomputed on the next run instead of two vintages sitting side by
 * side in the same response.
 */
export function hashAnchorParams(params: SildelagetAnchorParams): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${(params as Record<string, unknown>)[key]}`)
    .join("&");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The slice of the ClickHouse repository this job needs. */
export type AisFixWindowSource = {
  getFixesForWindows(
    requests: AisFixWindowRequest[],
    maxFixesPerVessel?: number,
  ): Promise<Map<string, AisFixWindowRow[]>>;
};

/** The slice of the anchor repository this job needs. */
export type SildelagetAnchorStore = Pick<
  SildelagetAisAnchorRepository,
  "listCandidates" | "upsertMany"
>;

type Args = {
  windowDays: number;
  recompute: boolean;
  limit: number;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/**
 * Derives each Sildelaget report's AIS fishing positions and stores them, so
 * /api/catch can serve them straight from Postgres.
 *
 * This exists to kill a client fan-out: the FE spike fetched a 48 h track per
 * report in the browser, which is why it was capped at a dozen reports and
 * stuck behind a dev flag. Here the work happens once per report, for the
 * whole bubble window, and every report gets a result — including the reports
 * where the answer is "we cannot tell", which is recorded as a status rather
 * than left to look like a reported position.
 */
export function createSildelagetAisAnchorsJob(
  env: Env,
  deps: {
    anchors: SildelagetAnchorStore;
    vessels: VesselDirectory;
    fixes: AisFixWindowSource;
  },
) {
  return async function runSildelagetAisAnchorsJob(
    _previous: JobState | undefined,
    args: Args,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const params = anchorParamsFromEnv(env);
    const paramsHash = hashAnchorParams(params);
    const windowDays = args.windowDays || env.SILDELAGET_AIS_ANCHOR_WINDOW_DAYS;
    const range = dateRange(windowDays);

    const candidates = await deps.anchors.listCandidates({
      ...range,
      paramsHash,
      recompute: args.recompute,
      limit: args.limit,
    });
    context.reportProgress({
      phase: "derive",
      message: `${candidates.length} reports to derive (${range.from} → ${range.to})`,
      detailsTotal: candidates.length,
      detailsProcessed: 0,
    });
    if (candidates.length === 0) {
      return {
        checkedAt,
        changed: false,
        latestItems: [],
        message: `No Sildelaget reports needed derived positions (${range.from} → ${range.to})`,
      };
    }

    const counts: Record<string, number> = {
      ok: 0,
      "no-vessel": 0,
      "no-track": 0,
      "no-run": 0,
      "no-date": 0,
    };
    let runsTotal = 0;
    let processed = 0;
    let flagged = 0;

    const batchSize = env.SILDELAGET_AIS_ANCHOR_BATCH_REPORTS;
    for (let i = 0; i < candidates.length; i += batchSize) {
      if (context.signal.aborted || context.isStopRequested()) break;
      const batch = candidates.slice(i, i + batchSize);
      const prepared = await Promise.all(
        batch.map((candidate) => prepare(candidate, deps.vessels, params)),
      );

      const requests: AisFixWindowRequest[] = [];
      for (const item of prepared) {
        if (item.vesselId !== null && item.window) {
          requests.push({
            key: item.candidate.innmeldingId,
            vesselId: item.vesselId,
            from: item.window.from,
            to: item.window.to,
          });
        }
      }
      const fixesByKey = await deps.fixes.getFixesForWindows(requests);

      const derived: SildelagetAisAnchor[] = [];
      for (const item of prepared) {
        if (!item.window || item.reportedAtMs === null) {
          // No usable report timestamp ⇒ no window to look in. Counted, not
          // stored: there is nothing to recompute later.
          counts["no-date"] = (counts["no-date"] ?? 0) + 1;
          continue;
        }
        const anchor = deriveSildelagetAisAnchor(
          {
            innmeldingId: item.candidate.innmeldingId,
            vesselId: item.vesselId,
            reportedAtMs: item.reportedAtMs,
            reportedLatitude: item.candidate.reportedLatitude,
            reportedLongitude: item.candidate.reportedLongitude,
            windowFrom: item.window.from,
            windowTo: item.window.to,
            fixes: fixesByKey.get(item.candidate.innmeldingId) ?? [],
          },
          { thresholds: params, sanityKm: params.sanityKm },
        );
        counts[anchor.status] = (counts[anchor.status] ?? 0) + 1;
        runsTotal += anchor.runs.length;
        flagged += anchor.runs.filter((run) => run.beyondSanityLimit).length;
        derived.push(anchor);
      }

      await deps.anchors.upsertMany(derived, params, paramsHash);
      processed += batch.length;
      context.reportProgress({
        phase: "derive",
        message: `${processed}/${candidates.length} reports derived`,
        detailsProcessed: processed,
        detailsTotal: candidates.length,
      });
    }

    const summary = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    return {
      checkedAt,
      changed: (counts.ok ?? 0) > 0,
      latestItems: [],
      message: `Derived positions for ${processed} reports (${summary}; ${runsTotal} runs, ${flagged} beyond ${params.sanityKm} km)`,
    };
  };
}

type PreparedCandidate = {
  candidate: SildelagetAnchorCandidate;
  vesselId: number | null;
  reportedAtMs: number | null;
  window: { from: string; to: string } | null;
};

async function prepare(
  candidate: SildelagetAnchorCandidate,
  vessels: VesselDirectory,
  params: SildelagetAnchorParams,
): Promise<PreparedCandidate> {
  const reportedAtMs = reportEpochMs(
    candidate.reportedDate,
    candidate.reportedTime,
    params.timeZone,
  );
  const vesselId = await vessels.resolve(
    candidate.vesselName,
    candidate.registrationMark,
  );
  return {
    candidate,
    vesselId,
    reportedAtMs,
    window:
      reportedAtMs === null
        ? null
        : anchorWindow(reportedAtMs, params.lookbackHours),
  };
}

/** Reported-date range covering the last `windowDays` days, inclusive. */
function dateRange(windowDays: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);
  return { from: dateOnly(from), to: dateOnly(to) };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
