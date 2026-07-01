/**
 * Financials data access over the main FishFacts MySQL DB (annual_report_*),
 * read through the existing AIS Cloud SQL pool (`getAisPool`) — the `usable` DB
 * user has access. Single-company reports are returned in the report's NATIVE
 * currency (×1000), with CALCULATED accounts derived in `accounts.ts`.
 *
 * Cross-company / market comparisons are intentionally NOT here in v1: reports
 * are stored per native currency and there is no FX table, so mixing companies
 * would be apples-to-oranges. Add once an FX source exists.
 */
import type { Env } from "@/env";
import type { RowDataPacket } from "mysql2";
import type { Pool } from "mysql2/promise";

import { getAisPool } from "../ais/mysql-pool";
import type { Database } from "../db/client";
import {
  ANNUAL_REPORT_ACCOUNTS,
  type AccountSection,
  type AccountType,
  type KeyFigures,
  computeKeyFigures,
  resolveAccountValues,
} from "./accounts";
import { FxRates } from "./fx";

export type CompanyRow = {
  id: number;
  name: string;
  country: string | null;
};

/** One company's value for a market (cross-company) scatter/bar. */
export type MarketPoint = {
  companyId: number;
  company: string;
  country: string | null;
  categories: string[];
  /** Metric value + gross profit, converted to the display currency, ×1000. */
  value: number | null;
  grossProfit: number | null;
};

/** One company's metric time series for a compare chart. */
export type CompanySeries = {
  companyId: number;
  company: string;
  points: Array<{ year: number; value: number | null }>;
};

const KEY_TO_ID = new Map(ANNUAL_REPORT_ACCOUNTS.map((a) => [a.key, a.id]));

/** Resolve a metric key (e.g. "EBITDA") to its account id, or null. */
function metricAccountId(metric: string): number | null {
  return KEY_TO_ID.get(metric.trim().toUpperCase()) ?? null;
}

/** The category tags on a company (from `company.labels`, minus app names). */
function parseCategories(labels: string | null): string[] {
  if (!labels) return [];
  return labels
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && s !== "FISHFACTS" && s !== "AQUAFACTS");
}

export type AccountSeries = {
  id: number;
  key: string;
  label: string;
  section: AccountSection;
  type: AccountType;
  /** year → value (native currency, ×1000). */
  values: Record<number, number>;
};

export type CompanyReport = {
  company: CompanyRow;
  /** Currency of the latest year shown (reports are single-currency). */
  currency: string | null;
  years: number[];
  accounts: AccountSeries[];
  keyFigures: Record<number, KeyFigures>;
  /** Values are in thousands of the currency. */
  scale: 1000;
  note?: string;
};

export class FinancialsRepository {
  private readonly fx: FxRates;

  constructor(
    private readonly env: Env,
    db: Database,
  ) {
    this.fx = new FxRates(db);
  }

  private pool(): Promise<Pool> {
    // "backfill" = the analytical read pool (never the live AIS tail).
    return getAisPool(this.env, "backfill");
  }

  /** Companies that have annual reports, by name search + optional category. */
  async searchCompanies(
    query: string | undefined,
    limit: number,
    category?: string,
  ): Promise<CompanyRow[]> {
    const pool = await this.pool();
    const params: Array<string | number> = [`%${(query ?? "").trim()}%`];
    let sql = `SELECT c.id, c.name, c.country
         FROM company c
        WHERE c.name LIKE ?
          AND c.name NOT LIKE '%(OLD)%'
          AND EXISTS (
            SELECT 1 FROM annual_report ar
             WHERE ar.company_id = c.id AND ar.period = 'YEAR'
          )`;
    if (category) {
      sql += " AND FIND_IN_SET(?, REPLACE(c.labels, ' ', '')) > 0";
      params.push(category.trim().toUpperCase());
    }
    sql += " ORDER BY c.name LIMIT ?";
    params.push(limit);
    const [rows] = await pool.query<(RowDataPacket & CompanyRow)[]>(
      sql,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      country: r.country,
    }));
  }

  /**
   * Full annual report for one company: income statement + balance sheet
   * accounts (basic + calculated) across years, plus key figures. Native
   * currency, values ×1000.
   */
  async getCompanyReport(
    companyId: number,
    years?: number[],
    displayCurrency?: string,
  ): Promise<CompanyReport | null> {
    const pool = await this.pool();
    const want = displayCurrency?.trim().toUpperCase() || undefined;

    const [coRows] = await pool.query<(RowDataPacket & CompanyRow)[]>(
      "SELECT id, name, country FROM company WHERE id = ? LIMIT 1",
      [companyId],
    );
    if (coRows.length === 0) return null;
    const company: CompanyRow = {
      id: Number(coRows[0].id),
      name: coRows[0].name,
      country: coRows[0].country,
    };

    const yearList = (years ?? []).filter((y) => Number.isInteger(y));
    const yearFilter = yearList.length
      ? ` AND year IN (${yearList.map(() => "?").join(",")})`
      : "";
    const [reps] = await pool.query<
      (RowDataPacket & { id: number; currency_id: string; year: number })[]
    >(
      `SELECT id, currency_id, year FROM annual_report
        WHERE company_id = ? AND period = 'YEAR'${yearFilter}
        ORDER BY year`,
      [companyId, ...yearList],
    );
    if (reps.length === 0) {
      return {
        company,
        currency: want ?? null,
        years: [],
        accounts: [],
        keyFigures: {},
        scale: 1000,
      };
    }

    const reportIds = reps.map((r) => Number(r.id));
    const yearByReport = new Map<number, number>(
      reps.map((r) => [Number(r.id), Number(r.year)]),
    );
    const currencyByYear = new Map<number, string>(
      reps.map((r) => [Number(r.year), r.currency_id]),
    );

    const [vals] = await pool.query<
      (RowDataPacket & {
        annual_report_id: number;
        annual_report_account_id: number;
        value: number;
      })[]
    >(
      `SELECT annual_report_id, annual_report_account_id, value
         FROM annual_report_account_value
        WHERE annual_report_id IN (${reportIds.map(() => "?").join(",")})`,
      reportIds,
    );

    const storedByYear = new Map<number, Map<number, number>>();
    for (const r of reps) storedByYear.set(Number(r.year), new Map());
    for (const v of vals) {
      const y = yearByReport.get(Number(v.annual_report_id));
      if (y === undefined) continue;
      storedByYear
        .get(y)
        ?.set(Number(v.annual_report_account_id), Number(v.value));
    }

    const sortedYears = reps.map((r) => Number(r.year)).sort((a, b) => a - b);

    const resolvedByYear = new Map<number, Map<number, number>>();
    const keyFigures: Record<number, KeyFigures> = {};
    for (const y of sortedYears) {
      const resolved = resolveAccountValues(storedByYear.get(y) ?? new Map());
      resolvedByYear.set(y, resolved);
      // Ratios are currency-neutral — computed on native values.
      keyFigures[y] = computeKeyFigures(resolved);
    }

    // FX: precompute the rate map for each year that needs converting.
    const ratesByYear = new Map<number, Map<string, number>>();
    const convertFailed = new Set<number>();
    if (want) {
      for (const y of sortedYears) {
        const native = currencyByYear.get(y);
        if (native && native !== want) {
          ratesByYear.set(y, await this.fx.ratesForYear(y));
        }
      }
    }
    const conv = (year: number, v: number): number => {
      if (!want) return v;
      const native = currencyByYear.get(year);
      if (!native || native === want) return v;
      const c = this.fx.convert(
        v,
        native,
        want,
        ratesByYear.get(year) ?? new Map(),
      );
      if (c === null) {
        convertFailed.add(year);
        return v;
      }
      return Math.round(c);
    };

    const accounts: AccountSeries[] = ANNUAL_REPORT_ACCOUNTS.map((a) => {
      const values: Record<number, number> = {};
      for (const y of sortedYears) {
        values[y] = conv(y, resolvedByYear.get(y)?.get(a.id) ?? 0);
      }
      return {
        id: a.id,
        key: a.key,
        label: a.label,
        section: a.section,
        type: a.type,
        values,
      };
    });

    const currencies = new Set(reps.map((r) => r.currency_id));
    const notes: string[] = [];
    if (!want && currencies.size > 1) {
      notes.push(
        `Report years use multiple currencies (${Array.from(currencies).join(", ")}); values are each year's native currency.`,
      );
    }
    if (want && convertFailed.size > 0) {
      notes.push(
        `Some years could not be converted to ${want} and are shown in native currency.`,
      );
    }
    return {
      company,
      currency: want ?? reps[reps.length - 1]?.currency_id ?? null,
      years: sortedYears,
      accounts,
      keyFigures,
      scale: 1000,
      note: notes.length ? notes.join(" ") : undefined,
    };
  }

  /**
   * Cross-company market snapshot for one metric + year: each company's metric
   * value + gross profit, converted to `displayCurrency` (default DKK).
   * Powers Market Overview / Peer Group scatter and List Overview / Compare bars.
   */
  async getMarket(opts: {
    metric: string;
    year: number;
    displayCurrency?: string;
    country?: string;
    category?: string;
    limit?: number;
  }): Promise<{
    metric: string;
    year: number;
    currency: string;
    points: MarketPoint[];
  }> {
    const metricId = metricAccountId(opts.metric);
    const gpId = KEY_TO_ID.get("GROSS_PROFIT") ?? 4;
    const want = opts.displayCurrency?.trim().toUpperCase() || "DKK";
    const out = {
      metric: opts.metric.toUpperCase(),
      year: opts.year,
      currency: want,
    };
    if (metricId === null) return { ...out, points: [] };

    const pool = await this.pool();
    const params: Array<string | number> = [opts.year];
    let sql = `SELECT ar.id AS report_id, ar.company_id, ar.currency_id,
                      c.name, c.country, c.labels
                 FROM annual_report ar
                 JOIN company c ON c.id = ar.company_id
                WHERE ar.period = 'YEAR' AND ar.year = ?
                  AND c.name NOT LIKE '%(OLD)%'`;
    if (opts.country) {
      sql += " AND c.country = ?";
      params.push(opts.country.trim().toUpperCase());
    }
    if (opts.category) {
      sql += " AND FIND_IN_SET(?, REPLACE(c.labels, ' ', '')) > 0";
      params.push(opts.category.trim().toUpperCase());
    }
    const [reps] = await pool.query<
      (RowDataPacket & {
        report_id: number;
        company_id: number;
        currency_id: string;
        name: string;
        country: string | null;
        labels: string | null;
      })[]
    >(sql, params);
    if (reps.length === 0) return { ...out, points: [] };

    const reportIds = reps.map((r) => Number(r.report_id));
    const stored = await this.valuesByReport(pool, reportIds);
    const rates = await this.fx.ratesForYear(opts.year);

    const points: MarketPoint[] = [];
    for (const r of reps) {
      const resolved = resolveAccountValues(
        stored.get(Number(r.report_id)) ?? new Map(),
      );
      const native = r.currency_id;
      const cv = (id: number): number | null => {
        const raw = resolved.get(id);
        if (raw === undefined) return null;
        if (native === want) return raw;
        const c = this.fx.convert(raw, native, want, rates);
        return c === null ? null : Math.round(c);
      };
      const value = cv(metricId);
      if (value === null) continue;
      points.push({
        companyId: Number(r.company_id),
        company: r.name,
        country: r.country,
        categories: parseCategories(r.labels),
        value,
        grossProfit: cv(gpId),
      });
    }
    points.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    return { ...out, points: points.slice(0, limit) };
  }

  /** Metric time series per company, converted to `displayCurrency` (default DKK). */
  async getCompare(opts: {
    metric: string;
    companyIds: number[];
    displayCurrency?: string;
  }): Promise<{ metric: string; currency: string; series: CompanySeries[] }> {
    const metricId = metricAccountId(opts.metric);
    const want = opts.displayCurrency?.trim().toUpperCase() || "DKK";
    const ids = opts.companyIds.filter((n) => Number.isInteger(n));
    const base = { metric: opts.metric.toUpperCase(), currency: want };
    if (ids.length === 0 || metricId === null) return { ...base, series: [] };

    const pool = await this.pool();
    const [reps] = await pool.query<
      (RowDataPacket & {
        report_id: number;
        company_id: number;
        currency_id: string;
        year: number;
        name: string;
      })[]
    >(
      `SELECT ar.id AS report_id, ar.company_id, ar.currency_id, ar.year, c.name
         FROM annual_report ar
         JOIN company c ON c.id = ar.company_id
        WHERE ar.period = 'YEAR'
          AND ar.company_id IN (${ids.map(() => "?").join(",")})
        ORDER BY ar.year`,
      ids,
    );
    if (reps.length === 0) return { ...base, series: [] };

    const stored = await this.valuesByReport(
      pool,
      reps.map((r) => Number(r.report_id)),
    );
    const ratesByYear = new Map<number, Map<string, number>>();
    for (const y of new Set(reps.map((r) => Number(r.year)))) {
      ratesByYear.set(y, await this.fx.ratesForYear(y));
    }

    const byCompany = new Map<number, CompanySeries>();
    for (const r of reps) {
      const resolved = resolveAccountValues(
        stored.get(Number(r.report_id)) ?? new Map(),
      );
      const raw = resolved.get(metricId);
      let value: number | null = raw === undefined ? null : raw;
      if (value !== null && r.currency_id !== want) {
        const c = this.fx.convert(
          value,
          r.currency_id,
          want,
          ratesByYear.get(Number(r.year)) ?? new Map(),
        );
        value = c === null ? null : Math.round(c);
      }
      let s = byCompany.get(Number(r.company_id));
      if (!s) {
        s = { companyId: Number(r.company_id), company: r.name, points: [] };
        byCompany.set(Number(r.company_id), s);
      }
      s.points.push({ year: Number(r.year), value });
    }
    return { ...base, series: Array.from(byCompany.values()) };
  }

  /** Distinct fishing-category tags across companies that have annual reports. */
  async listCategories(): Promise<string[]> {
    const pool = await this.pool();
    const [rows] = await pool.query<(RowDataPacket & { labels: string })[]>(
      `SELECT DISTINCT labels FROM company
        WHERE labels IS NOT NULL AND labels <> ''
          AND EXISTS (
            SELECT 1 FROM annual_report ar
             WHERE ar.company_id = company.id AND ar.period = 'YEAR'
          )`,
    );
    const set = new Set<string>();
    for (const r of rows) for (const c of parseCategories(r.labels)) set.add(c);
    return Array.from(set).sort();
  }

  /** reportId → (accountId → value) for a set of report ids. */
  private async valuesByReport(
    pool: Pool,
    reportIds: number[],
  ): Promise<Map<number, Map<number, number>>> {
    const out = new Map<number, Map<number, number>>();
    if (reportIds.length === 0) return out;
    for (const id of reportIds) out.set(id, new Map());
    const [vals] = await pool.query<
      (RowDataPacket & {
        annual_report_id: number;
        annual_report_account_id: number;
        value: number;
      })[]
    >(
      `SELECT annual_report_id, annual_report_account_id, value
         FROM annual_report_account_value
        WHERE annual_report_id IN (${reportIds.map(() => "?").join(",")})`,
      reportIds,
    );
    for (const v of vals) {
      out
        .get(Number(v.annual_report_id))
        ?.set(Number(v.annual_report_account_id), Number(v.value));
    }
    return out;
  }
}
