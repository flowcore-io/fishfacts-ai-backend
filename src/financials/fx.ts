/**
 * Currency conversion for annual-report figures. Reports are stored in one
 * native currency; to compare companies we normalise to a display currency.
 *
 * Rates are EUR-based year-end rates from Frankfurter (ECB data — free, no key,
 * covers all 7 report currencies incl. ISK), cached in the `fx_rate` table so a
 * Frankfurter outage or cold start doesn't block conversion once seeded.
 * Convert X→Y via rate(EUR→Y) / rate(EUR→X).
 */
import { eq, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { fxRate } from "../db/schema";

const FRANKFURTER = "https://api.frankfurter.dev/v1";
// EUR is the base (rate 1); these are the other report currencies.
const QUOTES = ["DKK", "GBP", "ISK", "NOK", "SEK", "USD"];
export const SUPPORTED_CURRENCIES = ["EUR", ...QUOTES];

export class FxRates {
  // year → (quote → EUR-to-quote rate); EUR is always 1.
  private readonly cache = new Map<number, Map<string, number>>();

  constructor(private readonly db: Database) {}

  /** EUR-based rate map for a year (from cache → table → Frankfurter). */
  async ratesForYear(year: number): Promise<Map<string, number>> {
    const cached = this.cache.get(year);
    if (cached) return cached;

    const rows = await this.db
      .select()
      .from(fxRate)
      .where(eq(fxRate.year, year));
    const map = new Map<string, number>(rows.map((r) => [r.quote, r.rate]));
    map.set("EUR", 1);

    const missing = QUOTES.filter((q) => !map.has(q));
    if (missing.length > 0) {
      const fetched = await this.fetchYear(year);
      if (fetched) {
        const values = [...fetched.rates.entries()].map(([quote, rate]) => ({
          year,
          quote,
          rate,
          asOf: fetched.asOf,
        }));
        if (values.length > 0) {
          await this.db
            .insert(fxRate)
            .values(values)
            .onConflictDoUpdate({
              target: [fxRate.year, fxRate.quote],
              set: {
                rate: sql`excluded.rate`,
                asOf: sql`excluded.as_of`,
                fetchedAt: sql`now()`,
              },
            });
          for (const [q, r] of fetched.rates) map.set(q, r);
        }
      }
    }

    this.cache.set(year, map);
    return map;
  }

  private async fetchYear(
    year: number,
  ): Promise<{ asOf: string; rates: Map<string, number> } | null> {
    // Year-end rate; Frankfurter returns the last trading day ≤ the date. For
    // the current/future year, use the latest available.
    const date =
      year >= new Date().getUTCFullYear() ? "latest" : `${year}-12-31`;
    try {
      const url = `${FRANKFURTER}/${date}?base=EUR&symbols=${QUOTES.join(",")}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      const body = (await resp.json()) as {
        date?: string;
        rates?: Record<string, number>;
      };
      const rates = new Map<string, number>(
        Object.entries(body.rates ?? {}).filter(
          ([, v]) => typeof v === "number" && Number.isFinite(v),
        ),
      );
      if (rates.size === 0) return null;
      return { asOf: body.date ?? String(year), rates };
    } catch {
      return null;
    }
  }

  /** Convert `value` from → to using a year's EUR-based rate map. */
  convert(
    value: number,
    from: string,
    to: string,
    rates: Map<string, number>,
  ): number | null {
    if (from === to) return value;
    const rf = from === "EUR" ? 1 : rates.get(from);
    const rt = to === "EUR" ? 1 : rates.get(to);
    if (!rf || !rt) return null;
    return (value / rf) * rt; // from → EUR → to
  }
}
