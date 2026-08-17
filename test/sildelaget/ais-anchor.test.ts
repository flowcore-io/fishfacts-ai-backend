import { describe, expect, test } from "bun:test";
import type { AisRunFix } from "../../src/ais/fishing-runs";
import {
  anchorWindow,
  deriveSildelagetAisAnchor,
  journalDateOnly,
  reportEpochMs,
} from "../../src/sildelaget/ais-anchor";

const MINUTE = 60_000;
const REPORTED_AT = Date.parse("2026-05-28T08:30:00.000Z");
// Operational settings, passed in by the job rather than defaulted in the
// domain module (they live in env.ts now).
const SANITY_KM = 150;
const OSLO = "Europe/Oslo";
const OPTIONS = { sanityKm: SANITY_KM };
const TRACK_START = REPORTED_AT - 6 * 60 * MINUTE;

/** Fixes for a slow working stretch near `latitude`. */
function workingRun(
  offsetMinutes: number,
  latitude: number,
  longitude: number,
): AisRunFix[] {
  return [0, 8, 16, 24].map((step) => ({
    epochMs: TRACK_START + (offsetMinutes + step) * MINUTE,
    latitude,
    longitude,
    speed: 2,
  }));
}

const baseInput = {
  innmeldingId: "123456",
  vesselId: 932,
  reportedAtMs: REPORTED_AT,
  reportedLatitude: 61,
  reportedLongitude: -6,
  windowFrom: new Date(REPORTED_AT - 48 * 3_600_000).toISOString(),
  windowTo: new Date(REPORTED_AT).toISOString(),
  fixes: [] as AisRunFix[],
};

describe("deriveSildelagetAisAnchor", () => {
  test("an unresolvable vessel is no-vessel, not an empty ok", () => {
    const anchor = deriveSildelagetAisAnchor(
      {
        ...baseInput,
        vesselId: null,
        fixes: workingRun(0, 61.2, -6.2),
      },
      OPTIONS,
    );
    expect(anchor.status).toBe("no-vessel");
    expect(anchor.runs).toEqual([]);
    expect(anchor.vesselId).toBeNull();
  });

  test("a resolved vessel with no fixes is no-track", () => {
    const anchor = deriveSildelagetAisAnchor(
      { ...baseInput, fixes: [] },
      OPTIONS,
    );
    expect(anchor.status).toBe("no-track");
    expect(anchor.fixCount).toBe(0);
  });

  test("fixes that never settle into a run are no-run, and say how many", () => {
    const anchor = deriveSildelagetAisAnchor(
      {
        ...baseInput,
        fixes: [0, 20, 40].map((step) => ({
          epochMs: TRACK_START + step * MINUTE,
          latitude: 61.2,
          longitude: -6.2,
          speed: 11,
        })),
      },
      OPTIONS,
    );
    expect(anchor.status).toBe("no-run");
    expect(anchor.runs).toEqual([]);
    expect(anchor.fixCount).toBe(3);
  });

  test("every qualifying run is returned, each measured against the report", () => {
    const anchor = deriveSildelagetAisAnchor(
      {
        ...baseInput,
        fixes: [
          ...workingRun(0, 61.2, -6),
          // A steaming leg between the two working stretches.
          {
            epochMs: TRACK_START + 40 * MINUTE,
            latitude: 61.3,
            longitude: -6,
            speed: 10,
          },
          ...workingRun(60, 61.4, -6),
        ],
      },
      OPTIONS,
    );
    expect(anchor.status).toBe("ok");
    expect(anchor.runs).toHaveLength(2);
    expect(anchor.runs[0]?.latitude).toBeCloseTo(61.2, 6);
    expect(anchor.runs[1]?.latitude).toBeCloseTo(61.4, 6);
    // 0.2° and 0.4° of latitude from the reported coordinate.
    expect(anchor.runs[0]?.distanceFromReportedKm).toBeCloseTo(22.2, 1);
    expect(anchor.runs[1]?.distanceFromReportedKm).toBeCloseTo(44.5, 1);
    expect(anchor.runs.every((run) => !run.beyondSanityLimit)).toBe(true);
  });

  test("a run far from the reported coordinate is FLAGGED, never dropped", () => {
    // ~2.5° of latitude ≈ 278 km — well past the 150 km sanity limit.
    const anchor = deriveSildelagetAisAnchor(
      {
        ...baseInput,
        fixes: workingRun(0, 63.5, -6),
      },
      OPTIONS,
    );
    expect(anchor.status).toBe("ok");
    expect(anchor.runs).toHaveLength(1);
    expect(anchor.runs[0]?.beyondSanityLimit).toBe(true);
    expect(anchor.runs[0]?.distanceFromReportedKm).toBeGreaterThan(SANITY_KM);
  });

  test("no reported coordinate ⇒ no distance claimed, and nothing flagged", () => {
    const anchor = deriveSildelagetAisAnchor(
      {
        ...baseInput,
        reportedLatitude: null,
        reportedLongitude: null,
        fixes: workingRun(0, 63.5, -6),
      },
      OPTIONS,
    );
    expect(anchor.runs[0]?.distanceFromReportedKm).toBeNull();
    expect(anchor.runs[0]?.beyondSanityLimit).toBe(false);
  });
});

describe("reportEpochMs — the journal's timezone, not the reader's", () => {
  test("summer (CEST, UTC+2)", () => {
    expect(reportEpochMs("2026-05-28", "10:30:00", OSLO)).toBe(
      Date.parse("2026-05-28T08:30:00.000Z"),
    );
  });

  test("winter (CET, UTC+1)", () => {
    expect(reportEpochMs("2026-01-15", "10:30:00", OSLO)).toBe(
      Date.parse("2026-01-15T09:30:00.000Z"),
    );
  });

  test("the day DST starts — 03:30 local is still UTC+2", () => {
    expect(reportEpochMs("2026-03-29", "03:30:00", OSLO)).toBe(
      Date.parse("2026-03-29T01:30:00.000Z"),
    );
  });

  test("a report with no time is journal-local midnight", () => {
    expect(reportEpochMs("2026-05-28", null, OSLO)).toBe(
      Date.parse("2026-05-27T22:00:00.000Z"),
    );
  });

  test("HH:MM without seconds is accepted", () => {
    expect(reportEpochMs("2026-05-28", "10:30", OSLO)).toBe(
      Date.parse("2026-05-28T08:30:00.000Z"),
    );
  });

  test("the zone is a parameter, so the contract does not follow the server", () => {
    expect(reportEpochMs("2026-05-28", "10:30:00", "UTC")).toBe(
      Date.parse("2026-05-28T10:30:00.000Z"),
    );
    expect(reportEpochMs("2026-05-28", "10:30:00", "Atlantic/Faroe")).toBe(
      Date.parse("2026-05-28T09:30:00.000Z"),
    );
  });

  test("a missing or malformed date yields null, never a guess", () => {
    expect(reportEpochMs(null, "10:30:00", OSLO)).toBeNull();
    expect(reportEpochMs("28.05.2026", "10:30:00", OSLO)).toBeNull();
  });
});

describe("journalDateOnly — the window is dated in the journal's zone", () => {
  // 00:30 Oslo on the 28th is still 22:30 UTC on the 27th. The candidate
  // window is compared against `reported_date`, which is journal-local, so
  // dating it off the server's UTC clock would leave a report filed just
  // after local midnight outside its own window until 02:00.
  const justAfterOsloMidnight = Date.parse("2026-05-27T22:30:00.000Z");

  test("just after local midnight, the journal is already on the next day", () => {
    expect(journalDateOnly(justAfterOsloMidnight, "Europe/Oslo")).toBe(
      "2026-05-28",
    );
    // What the server's own clock would have said.
    expect(new Date(justAfterOsloMidnight).toISOString().slice(0, 10)).toBe(
      "2026-05-27",
    );
  });

  test("shifts by whole days for the window's lower bound", () => {
    expect(journalDateOnly(justAfterOsloMidnight, "Europe/Oslo", -50)).toBe(
      "2026-04-08",
    );
    expect(journalDateOnly(justAfterOsloMidnight, "Europe/Oslo", -7)).toBe(
      "2026-05-21",
    );
  });

  test("winter, when Oslo is UTC+1", () => {
    expect(
      journalDateOnly(Date.parse("2026-01-14T23:30:00.000Z"), "Europe/Oslo"),
    ).toBe("2026-01-15");
  });
});

describe("anchorWindow", () => {
  test("ends at the report and reaches the lookback back", () => {
    const window = anchorWindow(REPORTED_AT, 48);
    expect(window.to).toBe(new Date(REPORTED_AT).toISOString());
    expect(window.from).toBe(
      new Date(REPORTED_AT - 48 * 3_600_000).toISOString(),
    );
  });
});
