import { Hono } from "hono";
import {
  CATCH_PAGE_LIMIT_DEFAULT,
  CATCH_PAGE_LIMIT_MAX,
  type CatchFilters,
  type FullCatchFilters,
  type SildelagetCatchRepository,
} from "./repository";

export type SildelagetCatchRouterDeps = {
  repository: SildelagetCatchRepository;
};

export function createSildelagetCatchRouter(
  deps: SildelagetCatchRouterDeps,
): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const parsed = parseCatchFilters(new URL(c.req.url).searchParams);
    if ("error" in parsed) return c.json(parsed, 400);
    return c.json(await deps.repository.aggregateFishfactsCatches(parsed));
  });

  app.get("/full", async (c) => {
    const parsed = parseFullFilters(new URL(c.req.url).searchParams);
    if ("error" in parsed) return c.json(parsed, 400);
    return c.json(await deps.repository.listFull(parsed));
  });

  return app;
}

function parseCatchFilters(
  params: URLSearchParams,
): CatchFilters | { error: "invalid_query"; message: string } {
  const defaults = defaultDateRange();
  const from = params.get("from")?.trim() || defaults.from;
  const to = params.get("to")?.trim() || defaults.to;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    return {
      error: "invalid_query",
      message: "from/to must be YYYY-MM-DD and from must be <= to",
    };
  }
  return {
    from,
    to,
    species: clean(params.get("species")),
    vesselName: clean(params.get("vesselName")),
    registrationMark: clean(params.get("registrationMark")),
  };
}

function parseFullFilters(
  params: URLSearchParams,
): FullCatchFilters | { error: "invalid_query"; message: string } {
  const base = parseCatchFilters(params);
  if ("error" in base) return base;
  return {
    ...base,
    innmeldingId: clean(params.get("innmeldingId")),
    q: clean(params.get("q")),
    limit: parseLimit(params.get("limit")),
    cursor: clean(params.get("cursor")),
  };
}

function parseLimit(raw: string | null): number {
  if (!raw) return CATCH_PAGE_LIMIT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return CATCH_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(parsed, 1), CATCH_PAGE_LIMIT_MAX);
}

function clean(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function defaultDateRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 365);
  return {
    from: dateOnly(from),
    to: dateOnly(today),
  };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
