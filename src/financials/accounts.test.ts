import { describe, expect, it } from "bun:test";
import { computeKeyFigures, resolveAccountValues } from "./accounts";

// Real stored BASIC values for Brim hf 2023 (EUR, ×1000) — calculated accounts
// are NOT stored and must be derived. Numbers from the live annual_report DB.
const BRIM_2023_BASICS = new Map<number, number>([
  // income statement
  [1, 282939], // REVENUE
  [3, -112015], // NET_OPERATING_EXPENSES
  [5, -83694], // SALARIES
  [7, -16110], // DEPRECIATION_AND_IMPAIRMENT
  [9, 11917], // RELATED_COMPANIES
  [10, -6986], // NET_FINANCIAL_EXPENSES
  [14, -12900], // TAXES
  [17, 36014], // DIVIDEND
  // assets
  [18, 309248],
  [21, 90489],
  [22, 30341],
  [23, 37438],
  [26, 241437],
  [28, 14325],
  [30, 49823],
  [31, 21148],
  [32, 30745],
  [34, 15601],
  // equity & liabilities
  [36, 20083],
  [37, 123129],
  [38, 333750],
  [40, 72783],
  [44, 240486],
  [46, 13993],
  [49, 13388],
  [58, 8661],
  [59, 14322],
]);

describe("annual report account calc", () => {
  const v = resolveAccountValues(BRIM_2023_BASICS);

  it("derives income-statement subtotals (cumulative signed sum)", () => {
    expect(v.get(4)).toBe(170924); // GROSS_PROFIT = 1+3
    expect(v.get(6)).toBe(87230); // EBITDA = GP + SALARIES
    expect(v.get(8)).toBe(71120); // EBIT = EBITDA + DEPR
    expect(v.get(11)).toBe(76051); // result before extraordinary
    expect(v.get(16)).toBe(63151); // RESULT_AFTER_TAXES
  });

  it("derives a balancing balance sheet (assets = equity + liabilities)", () => {
    expect(v.get(39)).toBe(476962); // EQUITY_TOTAL
    expect(v.get(35)).toBe(v.get(52)); // TOTAL_ASSETS === EQUITY_AND_LIABILITIES_TOTAL
    expect(v.get(35)).toBe((v.get(39) ?? 0) + (v.get(51) ?? 0));
  });

  it("computes key figures", () => {
    const kf = computeKeyFigures(v);
    expect(kf.ebitdaMargin).toBeCloseTo(87230 / 282939, 5);
    expect(kf.currentRatio).toBeGreaterThan(0);
  });
});
