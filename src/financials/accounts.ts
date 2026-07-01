/**
 * Annual-report account model — TS port of the canonical
 * `com.fishfacts.lib.model.annualreport.AnnualReportAccountEnum`.
 *
 * The DB dictionary table `annual_report_account` is stale/mismatched, so the
 * codebase enum is the source of truth (per Dmytro). `annual_report_account_value`
 * stores values keyed by these ids (1–59), in the report's native currency,
 * ×1000, with natural signs (expenses negative).
 *
 * Real reports store only BASIC accounts; CALCULATED accounts (subtotals like
 * Gross Profit / EBITDA / EBIT / totals) are derived here via `sumOf` (resolved
 * recursively — `sumOf` may reference other calculated ids). Income-statement
 * subtotals are cumulative; balance-sheet subtotals are nested per sub-group.
 *
 * NOTE: balance-sheet subtotal membership is inferred from enum order + the
 * `*_TOTAL` boundaries and validated against the live Power BI — confirm with
 * Dmytro before relying on it for filings.
 */

export type AccountType = "BASIC" | "CALCULATED";
export type AccountSection = "INCOME_STATEMENT" | "ASSETS" | "LIABILITIES";

export type AnnualReportAccount = {
  id: number;
  key: string;
  section: AccountSection;
  type: AccountType;
  /** English display label (matches the Power BI statements). */
  label: string;
  /** For CALCULATED accounts: ids whose (signed) values sum to this one. */
  sumOf?: number[];
};

// Order within each section is the display order (enum order).
export const ANNUAL_REPORT_ACCOUNTS: AnnualReportAccount[] = [
  // --- Income statement (enum section BALANCE_SHEET) ---
  {
    id: 1,
    key: "REVENUE",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Revenue",
  },
  {
    id: 2,
    key: "CHANGES_IN_INVENTORY",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Changes in inventory",
  },
  {
    id: 3,
    key: "NET_OPERATING_EXPENSES",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Net operating expenses",
  },
  {
    id: 4,
    key: "GROSS_PROFIT",
    section: "INCOME_STATEMENT",
    type: "CALCULATED",
    label: "Gross Profit",
    sumOf: [1, 2, 3],
  },
  {
    id: 5,
    key: "SALARIES",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Salaries",
  },
  {
    id: 6,
    key: "EBITDA",
    section: "INCOME_STATEMENT",
    type: "CALCULATED",
    label: "EBITDA",
    sumOf: [4, 5],
  },
  {
    id: 7,
    key: "DEPRECIATION_AND_IMPAIRMENT",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Depreciation & Impairment",
  },
  {
    id: 8,
    key: "EBIT",
    section: "INCOME_STATEMENT",
    type: "CALCULATED",
    label: "EBIT",
    sumOf: [6, 7],
  },
  {
    id: 9,
    key: "RELATED_COMPANIES",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Related companies",
  },
  {
    id: 10,
    key: "NET_FINANCIAL_EXPENSES",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Net financial expenses",
  },
  {
    id: 11,
    key: "RESULT_BEFORE_EXTRAORDINARY",
    section: "INCOME_STATEMENT",
    type: "CALCULATED",
    label: "Result before extraordinary",
    sumOf: [8, 9, 10],
  },
  {
    id: 12,
    key: "EXTRAORDINARY",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Extraordinary",
  },
  {
    id: 13,
    key: "RESULT_BEFORE_TAXES",
    section: "INCOME_STATEMENT",
    type: "CALCULATED",
    label: "Results Before Tax",
    sumOf: [11, 12],
  },
  {
    id: 14,
    key: "TAXES",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Taxes",
  },
  {
    id: 15,
    key: "FISHING_RIGHTS",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Catching rights",
  },
  {
    id: 16,
    key: "RESULT_AFTER_TAXES",
    section: "INCOME_STATEMENT",
    type: "CALCULATED",
    label: "Results After Tax",
    sumOf: [13, 14, 15],
  },
  {
    id: 17,
    key: "DIVIDEND",
    section: "INCOME_STATEMENT",
    type: "BASIC",
    label: "Dividend",
  },

  // --- Assets ---
  {
    id: 18,
    key: "LICENCES",
    section: "ASSETS",
    type: "BASIC",
    label: "Licences",
  },
  {
    id: 19,
    key: "GOODWILL",
    section: "ASSETS",
    type: "BASIC",
    label: "Goodwill",
  },
  {
    id: 56,
    key: "OTHER_INTANGIBLE_ASSETS",
    section: "ASSETS",
    type: "BASIC",
    label: "Other intangible assets",
  },
  {
    id: 20,
    key: "INTANGIBLE_ASSETS_TOTAL",
    section: "ASSETS",
    type: "CALCULATED",
    label: "Intangible assets total",
    sumOf: [18, 19, 56],
  },
  {
    id: 21,
    key: "VESSELS",
    section: "ASSETS",
    type: "BASIC",
    label: "Vessels",
  },
  {
    id: 22,
    key: "BUILDINGS_ETC",
    section: "ASSETS",
    type: "BASIC",
    label: "Buildings etc",
  },
  {
    id: 23,
    key: "EQUIPMENT",
    section: "ASSETS",
    type: "BASIC",
    label: "Equipment",
  },
  {
    id: 24,
    key: "OTHER_TANGIBLE_ASSETS",
    section: "ASSETS",
    type: "BASIC",
    label: "Other tangible assets",
  },
  {
    id: 25,
    key: "TANGIBLE_ASSETS_TOTAL",
    section: "ASSETS",
    type: "CALCULATED",
    label: "Tangible assets total",
    sumOf: [21, 22, 23, 24],
  },
  {
    id: 26,
    key: "RELATED_COMPANIES_ASSETS",
    section: "ASSETS",
    type: "BASIC",
    label: "Related companies",
  },
  { id: 27, key: "SHARES", section: "ASSETS", type: "BASIC", label: "Shares" },
  {
    id: 28,
    key: "RECEIVABLES",
    section: "ASSETS",
    type: "BASIC",
    label: "Receivables",
  },
  {
    id: 29,
    key: "FINANCIAL_ASSETS_TOTAL",
    section: "ASSETS",
    type: "CALCULATED",
    label: "Financial assets total",
    sumOf: [26, 27, 28],
  },
  {
    id: 57,
    key: "NON_CURRENT_ASSETS_TOTAL",
    section: "ASSETS",
    type: "CALCULATED",
    label: "Non-current assets total",
    sumOf: [20, 25, 29],
  },
  {
    id: 30,
    key: "INVENTORY",
    section: "ASSETS",
    type: "BASIC",
    label: "Inventory",
  },
  {
    id: 31,
    key: "OTHER_RECEIVABLES",
    section: "ASSETS",
    type: "BASIC",
    label: "Other receivables",
  },
  {
    id: 32,
    key: "RECEIVABLES_IN_RELATED_COMPANIES",
    section: "ASSETS",
    type: "BASIC",
    label: "Receivables in related companies",
  },
  { id: 34, key: "CASH", section: "ASSETS", type: "BASIC", label: "Cash" },
  {
    id: 33,
    key: "CURRENT_ASSETS_TOTAL",
    section: "ASSETS",
    type: "CALCULATED",
    label: "Current assets total",
    sumOf: [30, 31, 32, 34],
  },
  {
    id: 35,
    key: "TOTAL_ASSETS",
    section: "ASSETS",
    type: "CALCULATED",
    label: "Total assets",
    sumOf: [57, 33],
  },

  // --- Equity & liabilities ---
  {
    id: 36,
    key: "SHARE_CAPITAL",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Share capital",
  },
  {
    id: 38,
    key: "PROFIT_CARRIED_FORWARD",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Profit carried forward",
  },
  {
    id: 37,
    key: "FUNDS_PREMIUM_AND_OTHER_EQUITY",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Funds, premium and other equity",
  },
  {
    id: 39,
    key: "EQUITY_TOTAL",
    section: "LIABILITIES",
    type: "CALCULATED",
    label: "Equity total",
    sumOf: [36, 38, 37],
  },
  {
    id: 40,
    key: "DEFERRED_TAX_LIABILITIES",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Deferred tax liabilities",
  },
  {
    id: 44,
    key: "NON_CURRENT_MORTGAGE_AND_BANK_DEBTS",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Non-current mortgage and bank debts",
  },
  {
    id: 45,
    key: "NON_CURRENT_DEBT_TO_RELATED_COMPANIES",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Non-current debt to related companies",
  },
  {
    id: 41,
    key: "OTHER_NON_CURRENT_OBLIGATIONS",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Other non-current obligations",
  },
  {
    id: 43,
    key: "NON_CURRENT_LIABILITIES_TOTAL",
    section: "LIABILITIES",
    type: "CALCULATED",
    label: "Non-current liabilities total",
    sumOf: [40, 44, 45, 41],
  },
  {
    id: 58,
    key: "CURRENT_MORTGAGE_AND_BANK_DEBTS",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Current mortgage and bank debts",
  },
  {
    id: 46,
    key: "CORPORATION_TAX",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Corporation tax",
  },
  {
    id: 48,
    key: "DEBT_DIVIDEND",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Debt dividend",
  },
  {
    id: 59,
    key: "CURRENT_DEBT_TO_RELATED_COMPANIES",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Current debt to related companies",
  },
  {
    id: 49,
    key: "OTHER_CURRENT_LIABILITIES",
    section: "LIABILITIES",
    type: "BASIC",
    label: "Other current liabilities",
  },
  {
    id: 50,
    key: "CURRENT_LIABILITIES_TOTAL",
    section: "LIABILITIES",
    type: "CALCULATED",
    label: "Current liabilities total",
    sumOf: [58, 46, 48, 59, 49],
  },
  {
    id: 51,
    key: "LIABILITIES_TOTAL",
    section: "LIABILITIES",
    type: "CALCULATED",
    label: "Liabilities total",
    sumOf: [43, 50],
  },
  {
    id: 52,
    key: "EQUITY_AND_LIABILITIES_TOTAL",
    section: "LIABILITIES",
    type: "CALCULATED",
    label: "Equity and liabilities total",
    sumOf: [39, 51],
  },
];

export const ACCOUNT_BY_ID: Map<number, AnnualReportAccount> = new Map(
  ANNUAL_REPORT_ACCOUNTS.map((a) => [a.id, a]),
);

export function accountById(id: number): AnnualReportAccount | undefined {
  return ACCOUNT_BY_ID.get(id);
}

/**
 * Resolve a full set of account values for one report from the stored BASIC
 * values, computing CALCULATED accounts from `sumOf` (recursive + memoised).
 * A stored value (if present) always wins over the computed one.
 */
export function resolveAccountValues(
  stored: Map<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();

  const resolve = (id: number, seen: Set<number>): number => {
    if (out.has(id)) return out.get(id) as number;
    if (stored.has(id)) {
      const v = stored.get(id) as number;
      out.set(id, v);
      return v;
    }
    const acc = ACCOUNT_BY_ID.get(id);
    if (!acc || acc.type !== "CALCULATED" || !acc.sumOf || seen.has(id)) {
      out.set(id, 0);
      return 0;
    }
    seen.add(id);
    const v = acc.sumOf.reduce((sum, child) => sum + resolve(child, seen), 0);
    seen.delete(id);
    out.set(id, v);
    return v;
  };

  for (const acc of ANNUAL_REPORT_ACCOUNTS) resolve(acc.id, new Set());
  return out;
}

/** Key-figure ratios computed from resolved account values (matches Power BI). */
export type KeyFigures = {
  ebitMargin: number | null; // EBIT / Revenue
  ebitdaMargin: number | null; // EBITDA / Revenue
  ebitGrossProfit: number | null; // EBIT / Gross Profit
  ebitdaGrossProfit: number | null; // EBITDA / Gross Profit
  ebitdaTotalLiabilities: number | null; // EBITDA / Liabilities total
  netIncomeEquity: number | null; // Result after tax / Equity total
  netIncomeRevenue: number | null; // Result after tax / Revenue
  netIncomeGrossProfit: number | null; // Result after tax / Gross Profit
  liabilitiesEquity: number | null; // Liabilities total / Equity total
  currentRatio: number | null; // Current assets / Current liabilities
  quickRatio: number | null; // (Current assets - Inventory) / Current liabilities
};

const ID = {
  REVENUE: 1,
  GROSS_PROFIT: 4,
  EBITDA: 6,
  EBIT: 8,
  RESULT_AFTER_TAXES: 16,
  INVENTORY: 30,
  CURRENT_ASSETS_TOTAL: 33,
  EQUITY_TOTAL: 39,
  CURRENT_LIABILITIES_TOTAL: 50,
  LIABILITIES_TOTAL: 51,
} as const;

export function computeKeyFigures(values: Map<number, number>): KeyFigures {
  const v = (id: number) => values.get(id) ?? 0;
  const ratio = (num: number, den: number): number | null =>
    den === 0 ? null : num / den;
  return {
    ebitMargin: ratio(v(ID.EBIT), v(ID.REVENUE)),
    ebitdaMargin: ratio(v(ID.EBITDA), v(ID.REVENUE)),
    ebitGrossProfit: ratio(v(ID.EBIT), v(ID.GROSS_PROFIT)),
    ebitdaGrossProfit: ratio(v(ID.EBITDA), v(ID.GROSS_PROFIT)),
    ebitdaTotalLiabilities: ratio(v(ID.EBITDA), v(ID.LIABILITIES_TOTAL)),
    netIncomeEquity: ratio(v(ID.RESULT_AFTER_TAXES), v(ID.EQUITY_TOTAL)),
    netIncomeRevenue: ratio(v(ID.RESULT_AFTER_TAXES), v(ID.REVENUE)),
    netIncomeGrossProfit: ratio(v(ID.RESULT_AFTER_TAXES), v(ID.GROSS_PROFIT)),
    liabilitiesEquity: ratio(v(ID.LIABILITIES_TOTAL), v(ID.EQUITY_TOTAL)),
    currentRatio: ratio(
      v(ID.CURRENT_ASSETS_TOTAL),
      v(ID.CURRENT_LIABILITIES_TOTAL),
    ),
    quickRatio: ratio(
      v(ID.CURRENT_ASSETS_TOTAL) - v(ID.INVENTORY),
      v(ID.CURRENT_LIABILITIES_TOTAL),
    ),
  };
}
