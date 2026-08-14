/**
 * Derived catch positions for Sildelaget innmeldinger.
 *
 * A skipper reports a catch against a route area, so the coordinate on the
 * report is the centre of a box, not the spot the fish came from. The vessel's
 * AIS track knows better: it shows where the vessel slowed into fishing speed
 * and worked. This module turns one report plus that vessel's fixes into the
 * report's qualifying fishing runs (see ais/fishing-runs.ts), with an explicit
 * status whenever nothing can be derived — the client is then able to say so
 * instead of quietly falling back to the reported box centre.
 *
 * Pure: no I/O. The job (jobs/sildelaget-ais-anchors.ts) supplies the fixes and
 * persists the result; the read path serves it from Postgres.
 */
import {
  type AisFishingRun,
  type AisRunFix,
  DEFAULT_FISHING_RUN_THRESHOLDS,
  type FishingRunThresholds,
  deriveFishingRuns,
  haversineKm,
} from "@/ais/fishing-runs";

/** How far back from the report timestamp the track is examined. */
export const AIS_ANCHOR_LOOKBACK_HOURS = 48;

/**
 * A derived position further than this from the reported coordinate is
 * suspect — a wrong vessel match or a stale track. FLAGGED, never dropped:
 * dropping it would hide the disagreement, which is the thing worth seeing.
 */
export const AIS_ANCHOR_SANITY_KM = 150;

/**
 * The innmeldingsjournal is Norges Sildesalgslag's, and its dates and times
 * are Norwegian wall-clock. Pinned here rather than read from the server's
 * clock: the FE spike parsed them in the VIEWER's timezone, which is fine for
 * a demo and wrong as a contract — the same report would derive a different
 * window for a reader in Tórshavn and one in Bergen.
 */
export const SILDELAGET_JOURNAL_TIME_ZONE = "Europe/Oslo";

/** Why a report has no derived position — mirrors the FE's status union. */
export type SildelagetAisAnchorStatus =
  | "ok"
  | "no-vessel"
  | "no-track"
  | "no-run";

/** One derived fishing run, measured against what the skipper reported. */
export type SildelagetAisRun = AisFishingRun & {
  /**
   * Great-circle km between this run's centroid and the reported coordinate.
   * Null when the report carries no coordinate to compare against.
   */
  distanceFromReportedKm: number | null;
  /** distanceFromReportedKm exceeds AIS_ANCHOR_SANITY_KM — kept, but suspect. */
  beyondSanityLimit: boolean;
};

export type SildelagetAisAnchor = {
  innmeldingId: string;
  status: SildelagetAisAnchorStatus;
  vesselId: number | null;
  /** Report timestamp in UTC, resolved from journal-local date + time. */
  reportedAt: string | null;
  reportedLatitude: number | null;
  reportedLongitude: number | null;
  /** Track window examined, and how many fixes it held. */
  windowFrom: string;
  windowTo: string;
  fixCount: number;
  /** Every qualifying run, oldest first. Empty unless status is "ok". */
  runs: SildelagetAisRun[];
};

export type SildelagetAisAnchorOptions = {
  thresholds?: FishingRunThresholds;
  sanityKm?: number;
};

export type SildelagetAisAnchorInput = {
  innmeldingId: string;
  /** Null when the vessel could not be resolved to a FishFacts vessel id. */
  vesselId: number | null;
  /** Report timestamp (UTC ms), from reportEpochMs. */
  reportedAtMs: number | null;
  reportedLatitude: number | null;
  reportedLongitude: number | null;
  windowFrom: string;
  windowTo: string;
  /** Every fix in the window — including out-of-band ones, which end runs. */
  fixes: AisRunFix[];
};

export function deriveSildelagetAisAnchor(
  input: SildelagetAisAnchorInput,
  options: SildelagetAisAnchorOptions = {},
): SildelagetAisAnchor {
  const thresholds = options.thresholds ?? DEFAULT_FISHING_RUN_THRESHOLDS;
  const sanityKm = options.sanityKm ?? AIS_ANCHOR_SANITY_KM;
  const base = {
    innmeldingId: input.innmeldingId,
    vesselId: input.vesselId,
    reportedAt:
      input.reportedAtMs === null
        ? null
        : new Date(input.reportedAtMs).toISOString(),
    reportedLatitude: input.reportedLatitude,
    reportedLongitude: input.reportedLongitude,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
  };

  if (input.vesselId === null) {
    return { ...base, status: "no-vessel", fixCount: 0, runs: [] };
  }
  if (input.fixes.length === 0) {
    return { ...base, status: "no-track", fixCount: 0, runs: [] };
  }

  const runs = deriveFishingRuns(input.fixes, thresholds).map((run) =>
    withReportedDistance(
      run,
      input.reportedLatitude,
      input.reportedLongitude,
      sanityKm,
    ),
  );

  return {
    ...base,
    status: runs.length === 0 ? "no-run" : "ok",
    fixCount: input.fixes.length,
    runs,
  };
}

function withReportedDistance(
  run: AisFishingRun,
  reportedLatitude: number | null,
  reportedLongitude: number | null,
  sanityKm: number,
): SildelagetAisRun {
  if (reportedLatitude === null || reportedLongitude === null) {
    return { ...run, distanceFromReportedKm: null, beyondSanityLimit: false };
  }
  const km = haversineKm(
    run.latitude,
    run.longitude,
    reportedLatitude,
    reportedLongitude,
  );
  return {
    ...run,
    // One decimal: the reported coordinate is a route-area centre, so anything
    // finer would claim a precision neither side of the comparison has.
    distanceFromReportedKm: Number(km.toFixed(1)),
    beyondSanityLimit: km > sanityKm,
  };
}

/** The track window for a report: `lookbackHours` back from the report. */
export function anchorWindow(
  reportedAtMs: number,
  lookbackHours: number = AIS_ANCHOR_LOOKBACK_HOURS,
): { from: string; to: string } {
  return {
    from: new Date(reportedAtMs - lookbackHours * 3_600_000).toISOString(),
    to: new Date(reportedAtMs).toISOString(),
  };
}

/**
 * Journal-local `YYYY-MM-DD` + `HH:MM[:SS]` → epoch ms, or null when either is
 * missing or malformed. A report with no time is taken as local midnight — the
 * window then covers the two days before the reported day, which is the most
 * that date alone supports.
 */
export function reportEpochMs(
  reportedDate: string | null,
  reportedTime: string | null,
  timeZone: string = SILDELAGET_JOURNAL_TIME_ZONE,
): number | null {
  if (!reportedDate) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reportedDate.trim());
  if (!date) return null;
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    (reportedTime ?? "").trim(),
  );

  const asIfUtc = Date.UTC(
    Number(date[1]),
    Number(date[2]) - 1,
    Number(date[3]),
    time ? Number(time[1]) : 0,
    time ? Number(time[2]) : 0,
    time?.[3] ? Number(time[3]) : 0,
  );
  if (!Number.isFinite(asIfUtc)) return null;

  // Wall-clock → instant, the standard two-pass way: the zone's offset depends
  // on the instant we are still solving for, so take the offset at a first
  // guess and re-take it at the corrected one. Converges everywhere except the
  // repeated hour of a DST fall-back, where the earlier (summer) offset wins.
  const firstGuess = asIfUtc - timeZoneOffsetMs(asIfUtc, timeZone);
  return asIfUtc - timeZoneOffsetMs(firstGuess, timeZone);
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset (ms) of `timeZone` from UTC at a given instant. */
function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts = new Map(
    formatter.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second")),
  );
  return localAsUtc - epochMs;
}
