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
  deriveFishingRuns,
  haversineKm,
} from "@/ais/fishing-runs";

/**
 * The lookback window, the sanity limit and the journal's timezone are
 * OPERATIONAL settings and live in env.ts (SILDELAGET_AIS_ANCHOR_*,
 * SILDELAGET_JOURNAL_TIME_ZONE); the job passes them in. What counts as
 * fishing — the band and the coverage-gap rule — is not a setting at all: it
 * is fixed in ais/fishing-runs.ts, where /api/ais/effort reads it too.
 *
 * A derived position further from the reported coordinate than the sanity
 * limit is FLAGGED, never dropped: dropping it would hide the disagreement,
 * which is the thing worth seeing.
 *
 * The journal's timezone is pinned rather than read from the server's clock —
 * the FE spike parsed these timestamps in the VIEWER's timezone, which is fine
 * for a demo and wrong as a contract: the same report would derive a different
 * window for a reader in Tórshavn and one in Bergen.
 */

/**
 * Why a report has no derived position — mirrors the FE's status union.
 *
 * None of these is a dead end for the report: a vessel can appear in the
 * registry later, AIS ingest can still be catching up on the window, and a
 * backfill can add the fixes that turn a "no-run" into runs. They are stored
 * as the best current answer, and re-derived for a while (see
 * AIS_ANCHOR_RETRY_*). What must NEVER be written here is a failure to
 * consult a dependency — that is not an answer about the report at all.
 */
export type SildelagetAisAnchorStatus =
  | "ok"
  | "no-vessel"
  | "no-track"
  | "no-run";

/** Statuses worth asking again about — everything except a settled "ok". */
export const AIS_ANCHOR_RETRY_STATUSES: SildelagetAisAnchorStatus[] = [
  "no-vessel",
  "no-track",
  "no-run",
];

/**
 * How long a non-ok answer is left alone before it is re-derived. Registry
 * updates and AIS ingest lag both resolve on the scale of hours, so asking
 * again more often than this only re-reads ClickHouse for the same answer.
 */
export const AIS_ANCHOR_RETRY_AFTER_HOURS = 6;

/**
 * How long a report keeps being retried, measured from its reported date.
 * Without this the retry has no end and every undecided report in the window
 * is re-derived forever; with it, the churn is bounded to the days where the
 * inputs are actually still moving.
 */
export const AIS_ANCHOR_RETRY_WITHIN_DAYS = 7;

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
  sanityKm: number;
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
  options: SildelagetAisAnchorOptions,
): SildelagetAisAnchor {
  const sanityKm = options.sanityKm;
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

  const runs = deriveFishingRuns(input.fixes).map((run) =>
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
  lookbackHours: number,
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
  timeZone: string,
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

/**
 * `YYYY-MM-DD` for an instant AS THE JOURNAL WOULD DATE IT, optionally shifted
 * by whole days. The candidate window is compared against `reported_date`,
 * which is journal-local — so taking "today" from the server's UTC clock makes
 * the answer depend on where the process runs. Between 00:00 and 02:00 Oslo
 * that costs a report its first hour or two in the window, for the same reason
 * reportEpochMs exists.
 */
export function journalDateOnly(
  epochMs: number,
  timeZone: string,
  dayOffset = 0,
): string {
  const local = epochMs + timeZoneOffsetMs(epochMs, timeZone);
  const shifted = new Date(local + dayOffset * 86_400_000);
  return shifted.toISOString().slice(0, 10);
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
