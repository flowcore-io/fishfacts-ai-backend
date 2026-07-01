import { Hono } from "hono";

import type { FinancialsRepository } from "./repository";

export type FinancialsRouterDeps = {
  repository: FinancialsRepository;
};

/**
 * Financials REST router (mounted under /api/financials, auth-protected).
 *   GET /companies?q=&limit=   → companies with annual reports, by name
 *   GET /report?companyId=&years=  → income statement + balance sheet + key figures
 */
export function createFinancialsRouter(deps: FinancialsRouterDeps): Hono {
  const app = new Hono();

  app.get("/companies", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const q =
      params.get("q")?.trim() || params.get("query")?.trim() || undefined;
    const limit = parseLimit(params.get("limit"));
    const companies = await deps.repository.searchCompanies(q, limit);
    return c.json({ companies });
  });

  app.get("/report", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const companyId = Number.parseInt(params.get("companyId") ?? "", 10);
    if (!Number.isInteger(companyId)) {
      return c.json(
        { error: "invalid_query", message: "companyId (integer) is required" },
        400,
      );
    }
    const years = parseYears(params.get("years"));
    const report = await deps.repository.getCompanyReport(companyId, years);
    if (!report) {
      return c.json({ error: "not_found", message: "company not found" }, 404);
    }
    return c.json(report);
  });

  return app;
}

function parseLimit(raw: string | null): number {
  if (!raw) return 15;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 15;
  return Math.min(Math.max(parsed, 1), 50);
}

function parseYears(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const years = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1900 && n <= 2100);
  return years.length ? years : undefined;
}
