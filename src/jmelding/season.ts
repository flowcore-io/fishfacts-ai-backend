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

/** Reads unknown JSON off a row without trusting it. */
export function parseAnnualWindow(value: unknown): AnnualWindow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "annual") return null;
  const from = record.from;
  const to = record.to;
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (!/^\d{2}-\d{2}$/.test(from) || !/^\d{2}-\d{2}$/.test(to)) return null;
  return { type: "annual", from, to };
}

/** `MM-DD` for an instant, in UTC. Zero-padded so it compares lexicographically. */
function monthDayUtc(at: Date): string {
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  const day = String(at.getUTCDate()).padStart(2, "0");
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
 * Compared as `MM-DD` strings, which is exact for zero-padded fixed-width
 * fields and sidesteps constructing a date in a year that may not have the
 * day — 29 February being the obvious one.
 */
export function inSeason(window: AnnualWindow, at: Date): boolean {
  const today = monthDayUtc(at);
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
