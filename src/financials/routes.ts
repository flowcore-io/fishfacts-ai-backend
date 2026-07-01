import { Hono } from "hono";

import type { FinancialsRepository } from "./repository";

export type FinancialsRouterDeps = {
  repository: FinancialsRepository;
};

/**
 * Financials REST router (mounted under /api/financials, auth-protected).
 *   GET /companies?q=&limit=&category=  → companies with annual reports
 *   GET /report?companyId=&years=&currency=  → income statement + balance sheet + key figures
 *   GET /market?metric=&year=&currency=&country=&category=  → cross-company snapshot
 *   GET /compare?metric=&companyIds=&currency=  → metric time series per company
 *   GET /categories  → distinct fishing-category tags
 */
export function createFinancialsRouter(deps: FinancialsRouterDeps): Hono {
  const app = new Hono();

  app.get("/companies", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const q =
      params.get("q")?.trim() || params.get("query")?.trim() || undefined;
    const limit = parseLimit(params.get("limit"));
    const category = params.get("category")?.trim() || undefined;
    const companies = await deps.repository.searchCompanies(q, limit, category);
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
    const currency = params.get("currency")?.trim() || undefined;
    const report = await deps.repository.getCompanyReport(
      companyId,
      years,
      currency,
    );
    if (!report) {
      return c.json({ error: "not_found", message: "company not found" }, 404);
    }
    return c.json(report);
  });

  app.get("/market", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const metric = params.get("metric")?.trim();
    const year = Number.parseInt(params.get("year") ?? "", 10);
    if (!metric || !Number.isInteger(year)) {
      return c.json(
        { error: "invalid_query", message: "metric and year are required" },
        400,
      );
    }
    return c.json(
      await deps.repository.getMarket({
        metric,
        year,
        displayCurrency: params.get("currency")?.trim() || undefined,
        country: params.get("country")?.trim() || undefined,
        category: params.get("category")?.trim() || undefined,
        limit: parseLimit(params.get("limit"), 200, 500),
      }),
    );
  });

  app.get("/compare", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const metric = params.get("metric")?.trim();
    const companyIds = (params.get("companyIds") ?? "")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n));
    if (!metric || companyIds.length === 0) {
      return c.json(
        {
          error: "invalid_query",
          message: "metric and companyIds (csv) are required",
        },
        400,
      );
    }
    return c.json(
      await deps.repository.getCompare({
        metric,
        companyIds,
        displayCurrency: params.get("currency")?.trim() || undefined,
      }),
    );
  });

  app.get("/categories", async (c) => {
    return c.json({ categories: await deps.repository.listCategories() });
  });

  return app;
}

function parseLimit(raw: string | null, def = 15, max = 50): number {
  if (!raw) return def;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return def;
  return Math.min(Math.max(parsed, 1), max);
}

function parseYears(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const years = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1900 && n <= 2100);
  return years.length ? years : undefined;
}
