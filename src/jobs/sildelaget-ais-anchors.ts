import { createHash } from "node:crypto";
import type {
  AisFixWindowRequest,
  AisFixWindowRow,
} from "@/ais/clickhouse-repository";
import { FISHING_RUN_RULES } from "@/ais/fishing-runs";
import type { Env } from "@/env";
import {
  VESSEL_MATCH_RULES_VERSION,
  type VesselDirectory,
  type VesselLookup,
} from "@/fishfacts/vessel-directory";
import type { JobExecutionResult, JobState } from "@/jobs/types";
import {
  AIS_ANCHOR_RETRY_AFTER_HOURS,
  AIS_ANCHOR_RETRY_STATUSES,
  AIS_ANCHOR_RETRY_WITHIN_DAYS,
  type SildelagetAisAnchor,
  anchorWindow,
  deriveSildelagetAisAnchor,
  journalDateOnly,
  reportEpochMs,
} from "@/sildelaget/ais-anchor";
import type {
  SildelagetAisAnchorRepository,
  SildelagetAnchorCandidate,
} from "@/sildelaget/ais-anchor-repository";

/**
 * Everything the derivation depends on — hashed into each stored row. The
 * band and gap come from the code constants, not from config: they are what
 * "fishing" means, and they are shared with /api/ais/effort. Including them
 * here is what makes a row derived under an older definition recompute itself
 * once a new one deploys.
 *
 * Which vessel a report resolves to is part of that derivation, so the
 * matcher's rule version belongs here too — a `no-vessel` written before the
 * rules improved is exactly the row that has to be asked again.
 */
export type SildelagetAnchorParams = {
  vesselMatchRules: number;
  minKnots: number;
  maxKnots: number;
  maxGapMinutes: number;
  lookbackHours: number;
  sanityKm: number;
  timeZone: string;
};

export function anchorParamsFromEnv(env: Env): SildelagetAnchorParams {
  return {
    ...FISHING_RUN_RULES,
    vesselMatchRules: VESSEL_MATCH_RULES_VERSION,
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
  /** 0 ⇒ AIS_ANCHOR_RETRY_AFTER_HOURS. */
  retryAfterHours: number;
  /** 0 ⇒ AIS_ANCHOR_RETRY_WITHIN_DAYS. */
  retryWithinDays: number;
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
    /** Injectable for tests — the window's dating is timezone-sensitive. */
    now?: () => number;
  },
) {
  return async function runSildelagetAisAnchorsJob(
    _previous: JobState | undefined,
    args: Args,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const now = (deps.now ?? Date.now)();
    const params = anchorParamsFromEnv(env);
    const paramsHash = hashAnchorParams(params);
    const windowDays = args.windowDays || env.SILDELAGET_AIS_ANCHOR_WINDOW_DAYS;
    const retryWithinDays =
      args.retryWithinDays || AIS_ANCHOR_RETRY_WITHIN_DAYS;
    const range = dateRange(now, windowDays, params.timeZone);

    const candidates = await deps.anchors.listCandidates({
      ...range,
      paramsHash,
      recompute: args.recompute,
      limit: args.limit,
      retryStatuses: AIS_ANCHOR_RETRY_STATUSES,
      retryAfterHours: args.retryAfterHours || AIS_ANCHOR_RETRY_AFTER_HOURS,
      retryReportedFrom: journalDateOnly(
        now,
        params.timeZone,
        -retryWithinDays,
      ),
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
    };
    let runsTotal = 0;
    let stored = 0;
    let flagged = 0;
    // Reports deliberately left alone this run, with nothing written for them.
    let skippedUnavailable = 0;
    let skippedNoDate = 0;
    let firstUnavailableReason: string | null = null;

    const batchSize = env.SILDELAGET_AIS_ANCHOR_BATCH_REPORTS;
    for (let i = 0; i < candidates.length; i += batchSize) {
      if (context.signal.aborted || context.isStopRequested()) break;
      const batch = candidates.slice(i, i + batchSize);
      const prepared = await Promise.all(
        batch.map((candidate) => prepare(candidate, deps.vessels, params)),
      );

      const requests: AisFixWindowRequest[] = [];
      for (const item of prepared) {
        if (item.vessel.outcome === "resolved" && item.window) {
          requests.push({
            key: item.candidate.innmeldingId,
            vesselId: item.vessel.vesselId,
            from: item.window.from,
            to: item.window.to,
          });
        }
      }
      const fixesByKey = await deps.fixes.getFixesForWindows(requests);

      const derived: SildelagetAisAnchor[] = [];
      for (const item of prepared) {
        if (!item.window || item.reportedAtMs === null) {
          // No usable report timestamp ⇒ no window to look in. The candidate
          // query already excludes malformed dates, so this is a belt-and-
          // braces skip rather than the normal path.
          skippedNoDate += 1;
          continue;
        }
        if (item.vessel.outcome === "unavailable") {
          // The REGISTRY could not be consulted. That is not a fact about this
          // report, and writing it as no-vessel would bury the report under a
          // terminal-looking answer produced by an outage. Skip it: it stays a
          // candidate and the next run tries again.
          skippedUnavailable += 1;
          firstUnavailableReason ??= item.vessel.reason;
          continue;
        }
        const anchor = deriveSildelagetAisAnchor(
          {
            innmeldingId: item.candidate.innmeldingId,
            vesselId:
              item.vessel.outcome === "resolved" ? item.vessel.vesselId : null,
            reportedAtMs: item.reportedAtMs,
            reportedLatitude: item.candidate.reportedLatitude,
            reportedLongitude: item.candidate.reportedLongitude,
            windowFrom: item.window.from,
            windowTo: item.window.to,
            fixes: fixesByKey.get(item.candidate.innmeldingId) ?? [],
          },
          { sanityKm: params.sanityKm },
        );
        counts[anchor.status] = (counts[anchor.status] ?? 0) + 1;
        runsTotal += anchor.runs.length;
        flagged += anchor.runs.filter((run) => run.beyondSanityLimit).length;
        derived.push(anchor);
      }

      await deps.anchors.upsertMany(derived, params, paramsHash);
      stored += derived.length;
      context.reportProgress({
        phase: "derive",
        message: `${stored}/${candidates.length} reports derived`,
        detailsProcessed: stored,
        detailsTotal: candidates.length,
      });
    }

    const summary = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ");
    const skipped: string[] = [];
    if (skippedUnavailable > 0) {
      skipped.push(
        `${skippedUnavailable} left undecided (${firstUnavailableReason})`,
      );
    }
    if (skippedNoDate > 0) skipped.push(`${skippedNoDate} unusable dates`);
    return {
      checkedAt,
      changed: (counts.ok ?? 0) > 0,
      latestItems: [],
      // `stored` counts rows actually written — skipped reports are named
      // separately rather than folded into the headline number.
      message: `Derived positions for ${stored} reports (${summary}; ${runsTotal} runs, ${flagged} beyond ${params.sanityKm} km)${
        skipped.length > 0 ? `; skipped: ${skipped.join(", ")}` : ""
      }`,
    };
  };
}

type PreparedCandidate = {
  candidate: SildelagetAnchorCandidate;
  vessel: VesselLookup;
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
  // The report's `registrationMark` is the registry's `registrationNumber`;
  // the directory owns that rename.
  const vessel = await vessels.resolve(
    candidate.vesselName,
    candidate.registrationMark,
  );
  return {
    candidate,
    vessel,
    reportedAtMs,
    window:
      reportedAtMs === null
        ? null
        : anchorWindow(reportedAtMs, params.lookbackHours),
  };
}

/**
 * Reported-date range covering the last `windowDays` days, inclusive, dated
 * the way the journal dates things. `reported_date` is journal-local, so
 * taking "today" off the server's UTC clock would put a report filed just
 * after local midnight outside the window for the first hour or two of the
 * day — the reader's clock deciding the answer, which is the habit
 * reportEpochMs exists to break.
 */
function dateRange(
  nowMs: number,
  windowDays: number,
  timeZone: string,
): { from: string; to: string } {
  return {
    from: journalDateOnly(nowMs, timeZone, -windowDays),
    to: journalDateOnly(nowMs, timeZone),
  };
}
