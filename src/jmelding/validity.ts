/**
 * Validity dates for regulations, shared by all three jurisdictions.
 *
 * Each source publishes its window in its own shape — Fiskeridir writes
 * `19.06.2025` (day-first), Fiskistofa's WFS serves `2026-08-03Z` (an ISO date
 * with a stray zone suffix), Vørn writes it as Faroese prose ("galdandi frá í
 * dag, hin 1. juli 2026 klokkan 23:00 til 29. juli 2026 klokkan 23:00"). They
 * all land in the same `jmelding_geo.valid_from` / `valid_to` columns, so the
 * parsing lives here rather than three times over in the collectors.
 *
 * The point of persisting them is that `status = "current"` can then be
 * checked on read instead of trusted from scrape time — see
 * `JMeldingGeoRepository.inForce`.
 */

/** `19.06.2025`, `19/06/25`, `19-6-2025` — day first, as Fiskeridir writes it. */
const DAY_FIRST_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;
/** `2026-08-03`, optionally with Fiskistofa's trailing bare `Z`. */
const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** `2026-08-03T19:00:00Z` — a value that already carries a time of day. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ParsedValidityDate = {
  iso: string;
  /** True when the source gave a bare date, so the time of day is our choice. */
  dateOnly: boolean;
};

function utcInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Date.UTC rolls 31.02 forward into March — reject rather than invent a day.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.toISOString();
}

function fullYear(raw: number): number {
  return raw < 100 ? 2000 + raw : raw;
}

/**
 * Parse a source validity date into a UTC instant. Bare dates are anchored to
 * the start of the day; `parseValidityEnd` moves an end date to the end of it.
 */
export function parseValidityDate(
  raw?: string | null,
): ParsedValidityDate | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const dayFirst = value.match(DAY_FIRST_RE);
  if (dayFirst) {
    const iso = utcInstant(
      fullYear(Number(dayFirst[3])),
      Number(dayFirst[2]),
      Number(dayFirst[1]),
    );
    return iso ? { iso, dateOnly: true } : undefined;
  }

  // Fiskistofa serves date-only values with a zone suffix and no time
  // ("2026-08-03Z"), which `new Date` rejects outright.
  const isoDate = value.replace(/[Zz]$/, "").match(ISO_DATE_RE);
  if (isoDate) {
    const iso = utcInstant(
      Number(isoDate[1]),
      Number(isoDate[2]),
      Number(isoDate[3]),
    );
    return iso ? { iso, dateOnly: true } : undefined;
  }

  // Anything else must look like a timestamp before `new Date` sees it: left
  // to guess, it reads "í dag, hin 1" (Vørn's prose) as 1 January 2001.
  if (!ISO_DATETIME_RE.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : { iso: parsed.toISOString(), dateOnly: false };
}

/** Start of a validity window, as stored in `valid_from`. */
export function parseValidityStart(raw?: string | null): string | undefined {
  return parseValidityDate(raw)?.iso;
}

/**
 * End of a validity window, as stored in `valid_to`. A bare end date is
 * inclusive — a notice whose Utløpsdato is today is still in force today — so
 * it is pushed to the last instant of that day. Erring long keeps a
 * just-expired closure on the map rather than hiding one still in force.
 */
export function parseValidityEnd(raw?: string | null): string | undefined {
  const parsed = parseValidityDate(raw);
  if (!parsed) return undefined;
  if (!parsed.dateOnly) return parsed.iso;
  return new Date(Date.parse(parsed.iso) + MS_PER_DAY - 1).toISOString();
}

/** True once `validTo` is in the past. Unparseable/absent ends never expire. */
export function hasExpired(
  validTo?: string | null,
  now: Date = new Date(),
): boolean {
  const end = parseValidityEnd(validTo);
  return end !== undefined && Date.parse(end) < now.getTime();
}

/**
 * A date beats a keyword: whatever the source called it ("Gjeldende" on a
 * Norwegian notice, "active" on a Faroese ban or an Icelandic WFS feature), a
 * regulation whose validity window has closed is archived.
 */
export function withExpiry<T extends string>(
  status: T,
  validTo?: string | null,
  now: Date = new Date(),
): T | "archived" {
  return hasExpired(validTo, now) ? "archived" : status;
}

// ---------------------------------------------------------------------------
// 🇫🇴 Vørn — validity as Faroese prose.
// ---------------------------------------------------------------------------

/** Faroese month names, keyed by their first three letters. */
const FAROESE_MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  mai: 5,
  mei: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  nov: 11,
  des: 12,
};

/** `1. juli 2026`, optionally followed by `klokkan 23:00`. */
const FAROESE_DATE = String.raw`(\d{1,2})\.?\s*([a-záíóúýæøåðA-ZÁÍÓÚÝÆØÅÐ]{3,12})\.?\s*(\d{4})(?:\s*(?:kl\.?|klokkan)\s*(\d{1,2})[:.](\d{2}))?`;

/**
 * "Veiðibannið er galdandi frá í dag, hin 1. juli 2026 klokkan 23:00 til
 * 29. juli 2026 klokkan 23:00." — the whole window in one sentence. `til` is
 * allowed to repeat: bans nr. 12 and 13 of 2026 both read "klokkan 23:00 til
 * til 20. juli 2026", and a doubled word should not cost a ban its end date.
 */
const FAROESE_WINDOW_RE = new RegExp(
  String.raw`galdandi\s+fr[áa]\s+(?:í\s+dag[,\s]+)?(?:hin\s+)?${FAROESE_DATE}\s*(?:\btil\s+)+(?:og\s+vi[ðd]\s+)?${FAROESE_DATE}`,
  "i",
);

function faroeseInstant(
  day: string,
  monthName: string,
  year: string,
  hour?: string,
  minute?: string,
): string | undefined {
  const month = FAROESE_MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (!month) return undefined;
  // Faroese clock times are read as UTC. Local time is UTC in winter and UTC+1
  // in summer, so a summer ban is held at most an hour past its stated end —
  // the same conservative direction as the inclusive end date above.
  return utcInstant(
    Number(year),
    month,
    Number(day),
    hour ? Number(hour) : 0,
    minute ? Number(minute) : 0,
  );
}

/**
 * Read Vørn's "galdandi frá … til …" sentence into a validity window. A
 * bráðfeingis ban is inherently short-lived (typically four weeks), so this is
 * what makes an FO closure stop being current once its weeks are up.
 */
export function parseFaroeseValidityWindow(text: string): {
  validFrom?: string;
  validTo?: string;
} {
  const match = text.match(FAROESE_WINDOW_RE);
  if (!match) return {};
  return {
    validFrom: faroeseInstant(match[1], match[2], match[3], match[4], match[5]),
    validTo: faroeseInstant(match[6], match[7], match[8], match[9], match[10]),
  };
}
