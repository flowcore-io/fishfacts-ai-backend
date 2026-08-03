import { describe, expect, test } from "bun:test";
import {
  type AnnualWindow,
  inSeason,
  isInSeason,
  parseAnnualWindow,
} from "./season";

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

// K 45/2022 — the gýtingarleiðir spawning closure, 1 February to 1 May.
const SPAWNING: AnnualWindow = { type: "annual", from: "02-01", to: "05-01" };
// A window that wraps the year end. None of the three known closures do this
// today, but a wrapping window read as empty would never activate at all.
const WINTER: AnnualWindow = { type: "annual", from: "11-01", to: "03-01" };

describe("inSeason — a normal window", () => {
  test("closed in the middle of the season", () => {
    expect(inSeason(SPAWNING, at("2026-03-15"))).toBe(true);
  });

  test("open outside it", () => {
    // 3 August: the date this was written, and the one that made the point —
    // approving K 45/2022 without gating would have drawn it today.
    expect(inSeason(SPAWNING, at("2026-08-03"))).toBe(false);
    expect(inSeason(SPAWNING, at("2026-01-15"))).toBe(false);
  });

  test("both ends are inclusive", () => {
    // `til 1. mai` reads as closed ON 1 May; excluding it would open a spawning
    // ground a day early, every year, always in the same direction.
    expect(inSeason(SPAWNING, at("2026-02-01"))).toBe(true);
    expect(inSeason(SPAWNING, at("2026-05-01"))).toBe(true);
  });

  test("the days either side are outside", () => {
    expect(inSeason(SPAWNING, at("2026-01-31"))).toBe(false);
    expect(inSeason(SPAWNING, at("2026-05-02"))).toBe(false);
  });
});

describe("inSeason — a window that wraps the year end", () => {
  test("closed on both sides of new year", () => {
    expect(inSeason(WINTER, at("2026-12-15"))).toBe(true);
    expect(inSeason(WINTER, at("2026-01-15"))).toBe(true);
  });

  test("closed exactly on new year's eve and new year's day", () => {
    expect(inSeason(WINTER, at("2026-12-31"))).toBe(true);
    expect(inSeason(WINTER, at("2027-01-01"))).toBe(true);
  });

  test("open in the middle of the year", () => {
    expect(inSeason(WINTER, at("2026-07-01"))).toBe(false);
  });

  test("inclusive at both ends", () => {
    expect(inSeason(WINTER, at("2026-11-01"))).toBe(true);
    expect(inSeason(WINTER, at("2026-03-01"))).toBe(true);
    expect(inSeason(WINTER, at("2026-10-31"))).toBe(false);
    expect(inSeason(WINTER, at("2026-03-02"))).toBe(false);
  });
});

describe("inSeason — dates that break naive implementations", () => {
  // Comparing MM-DD strings avoids constructing a date in a year that may not
  // have the day.
  test("29 February works in a leap year", () => {
    const leapEnd: AnnualWindow = {
      type: "annual",
      from: "02-01",
      to: "02-29",
    };

    expect(inSeason(leapEnd, at("2028-02-29"))).toBe(true);
    expect(inSeason(leapEnd, at("2028-02-28"))).toBe(true);
  });

  test("a 29 February end still bounds a non-leap year", () => {
    const leapEnd: AnnualWindow = {
      type: "annual",
      from: "02-01",
      to: "02-29",
    };

    // 2026 has no 29 Feb; the window simply ends after the 28th.
    expect(inSeason(leapEnd, at("2026-02-28"))).toBe(true);
    expect(inSeason(leapEnd, at("2026-03-01"))).toBe(false);
  });

  test("a single-day window is exactly one day", () => {
    const oneDay: AnnualWindow = { type: "annual", from: "06-15", to: "06-15" };

    expect(inSeason(oneDay, at("2026-06-15"))).toBe(true);
    expect(inSeason(oneDay, at("2026-06-14"))).toBe(false);
    expect(inSeason(oneDay, at("2026-06-16"))).toBe(false);
  });

  test("the year of the instant is irrelevant", () => {
    for (const year of [2019, 2026, 2031]) {
      expect(inSeason(SPAWNING, at(`${year}-03-15`))).toBe(true);
      expect(inSeason(SPAWNING, at(`${year}-08-03`))).toBe(false);
    }
  });
});

describe("isInSeason — the gate as the read path uses it", () => {
  // The default that keeps this inert for Vørn, Fiskistofa and the Norwegian
  // J-meldinger: they carry no recurrence, so they pass through untouched.
  test("no recurrence means always in season", () => {
    expect(isInSeason(null, at("2026-08-03"))).toBe(true);
    expect(isInSeason(undefined, at("2026-08-03"))).toBe(true);
  });

  test("applies a stored window", () => {
    expect(isInSeason(SPAWNING, at("2026-03-15"))).toBe(true);
    expect(isInSeason(SPAWNING, at("2026-08-03"))).toBe(false);
  });

  // Fails OPEN on unreadable data, deliberately: the alternative is a stored
  // closure that silently stops being drawn because its recurrence column got
  // malformed, which hides a ban rather than over-reporting one.
  test("unreadable recurrence does not hide the closure", () => {
    expect(isInSeason({ type: "weekly" }, at("2026-08-03"))).toBe(true);
    expect(
      isInSeason({ type: "annual", from: "nonsense" }, at("2026-08-03")),
    ).toBe(true);
    expect(isInSeason("02-01/05-01", at("2026-08-03"))).toBe(true);
  });
});

describe("parseAnnualWindow", () => {
  test("accepts a well-formed window", () => {
    expect(
      parseAnnualWindow({ type: "annual", from: "02-01", to: "05-01" }),
    ).toEqual(SPAWNING);
  });

  test("rejects anything else", () => {
    expect(parseAnnualWindow(null)).toBeNull();
    expect(
      parseAnnualWindow({ type: "monthly", from: "02-01", to: "05-01" }),
    ).toBeNull();
    expect(
      parseAnnualWindow({ type: "annual", from: "2026-02-01", to: "05-01" }),
    ).toBeNull();
    expect(parseAnnualWindow({ type: "annual", from: 2, to: 5 })).toBeNull();
  });
});
