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
import {
  ANNUAL_REPORT_ACCOUNTS,
  type AccountSection,
  type AccountType,
  type KeyFigures,
  computeKeyFigures,
  resolveAccountValues,
} from "./accounts";

export type CompanyRow = {
  id: number;
  name: string;
  country: string | null;
};

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
  constructor(private readonly env: Env) {}

  private pool(): Promise<Pool> {
    // "backfill" = the analytical read pool (never the live AIS tail).
    return getAisPool(this.env, "backfill");
  }

  /** Companies that have annual reports, by name search. */
  async searchCompanies(
    query: string | undefined,
    limit: number,
  ): Promise<CompanyRow[]> {
    const pool = await this.pool();
    const like = `%${(query ?? "").trim()}%`;
    const [rows] = await pool.query<(RowDataPacket & CompanyRow)[]>(
      `SELECT c.id, c.name, c.country
         FROM company c
        WHERE c.name LIKE ?
          AND c.name NOT LIKE '%(OLD)%'
          AND EXISTS (
            SELECT 1 FROM annual_report ar
             WHERE ar.company_id = c.id AND ar.period = 'YEAR'
          )
        ORDER BY c.name
        LIMIT ?`,
      [like, limit],
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
  ): Promise<CompanyReport | null> {
    const pool = await this.pool();

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
        currency: null,
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
      keyFigures[y] = computeKeyFigures(resolved);
    }

    const accounts: AccountSeries[] = ANNUAL_REPORT_ACCOUNTS.map((a) => {
      const values: Record<number, number> = {};
      for (const y of sortedYears) {
        values[y] = resolvedByYear.get(y)?.get(a.id) ?? 0;
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
    return {
      company,
      currency: reps[reps.length - 1]?.currency_id ?? null,
      years: sortedYears,
      accounts,
      keyFigures,
      scale: 1000,
      note:
        currencies.size > 1
          ? `Report years use multiple currencies (${Array.from(currencies).join(", ")}); values are each year's native currency.`
          : undefined,
    };
  }
}
