/**
 * Is a seasonal closure in season right now?
 *
 * Faroese spawning closures state a bare date range with no year — `frá 1.
 * februar til 1. mai` — on a statute that is permanently in force. The window
 * therefore recurs annually as a matter of legal convention rather than text,
 * which is why a REVIEWER records it and the parser never can (plan decision 3).
 *
 * This module is the arithmetic half of `active()`, and it is deliberately
 * plain, pure and here rather than in the query: date maths is exactly what
 * gets silently wrong at year boundaries, and the failure is directional — a
 * closure that never activates hides a ban, one that never deactivates shows a
 * ban over open water. Both mislead a skipper, so it is worth being able to
 * test every edge without a database.
 */

export type AnnualWindow = {
  type: "annual";
  /** `MM-DD` */
  from: string;
  to: string;
};

/**
 * `MM-DD` restricted to real months and days.
 *
 * A loose `\d{2}-\d{2}` would accept `13-01`, and that value is worse than
 * useless: `from > to` sends it down the year-wrapping branch, where
 * `today >= "13-01"` can never hold, so the closure NEVER draws. A reviewer
 * typo would silently hide a live ban — the fail-CLOSED direction this module
 * exists to avoid. Rejecting it here routes it to `isInSeason`'s fail-OPEN
 * path instead, where an unreadable window means "always in season".
 *
 * `02-30` still passes (no month-length table here); that is deliberate — it
 * is a harmless bound, not a silent disable, and the review API rejects it at
 * entry with a real calendar check.
 */
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Reads unknown JSON off a row without trusting it. */
export function parseAnnualWindow(value: unknown): AnnualWindow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "annual") return null;
  const from = record.from;
  const to = record.to;
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (!MONTH_DAY.test(from) || !MONTH_DAY.test(to)) return null;
  return { type: "annual", from, to };
}

/**
 * `MM-DD` for an instant, in FAROESE local time.
 *
 * The statute's `til 1. mai` is a Faroese calendar date, and the islands run
 * UTC+1 in summer — so a UTC reading mis-classifies the last hour of a boundary
 * day. That is a sub-day version of precisely the off-by-one the "both ends
 * inclusive" rule guards against, and it costs one formatter to remove.
 */
const FAROE_MONTH_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Atlantic/Faroe",
  month: "2-digit",
  day: "2-digit",
});

function monthDayLocal(at: Date): string {
  const parts = FAROE_MONTH_DAY.formatToParts(at);
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${month}-${day}`;
}

/**
 * Is `at` inside the window?
 *
 * **Both ends are inclusive.** `frá 1. februar til 1. mai` reads in Faroese
 * statute as closed ON 1 May, and excluding the final day would open a spawning
 * ground a day early every year — a small error that always points the same
 * way.
 *
 * **A window whose `from` is later than `to` WRAPS the year end**, so
 * `11-01`→`03-01` means November through March rather than the empty set. None
 * of the three known seasonal closures wrap today, but the alternative to
 * handling it is a closure that silently never activates, and that is two lines
 * of code to avoid.
 *
 * Compared as `MM-DD` strings in Faroese local time, which is exact for
 * zero-padded fixed-width fields and sidesteps constructing a date in a year that may not have the
 * day — 29 February being the obvious one.
 */
export function inSeason(window: AnnualWindow, at: Date): boolean {
  const today = monthDayLocal(at);
  if (window.from <= window.to) {
    return today >= window.from && today <= window.to;
  }
  return today >= window.from || today <= window.to;
}

/**
 * The season half of `active()`: a row with no recurrence is always in season.
 *
 * That default is what keeps this inert for every other source. Vørn's
 * emergency bans, Fiskistofa's closures and the Norwegian J-meldinger carry no
 * recurrence, so they pass through untouched — the gate only ever narrows rows
 * a human deliberately marked as seasonal.
 */
export function isInSeason(recurrence: unknown, at: Date): boolean {
  const window = parseAnnualWindow(recurrence);
  return window === null || inSeason(window, at);
}
