import { randomUUID } from "node:crypto";
import { requireAdmin } from "@/auth/admin";
import { Hono } from "hono";
import type { ReportsClient } from "./client";
import { reportSubmissionSchema, truncateSubmission } from "./contracts";
import { buildReportFragment } from "./fragment";

export type ReportsRouterDeps = {
  /** null = feature not configured (no REPORT_FRAGMENT_TYPE_ID) — routes
   * answer 503 instead of the service failing boot. */
  reports: ReportsClient | null;
};

/**
 * In-chat issue reports (PRD: In-Chat Issue Reporting & Session Capture).
 * POST = any authenticated user submits a consented session capture; it is
 * enriched server-side and forwarded to Usable as a Report fragment.
 * GET list/detail = ADMIN-only proxy over the Usable fragments so the FE
 * admin screen never talks to (or holds a token for) the Usable API.
 * Auth middleware is applied by app.ts on the /api/reports prefix.
 */
export function createReportsRouter(deps: ReportsRouterDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    if (!deps.reports) {
      return c.json({ error: "reports_not_configured" }, 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = reportSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }
    // Oversized captures are truncated, never rejected (PRD §6.3).
    const { submission, truncation } = truncateSubmission(parsed.data);
    const reportId = randomUUID();
    const draft = buildReportFragment({
      reportId,
      submission,
      truncation,
      reporter: c.get("auth").user,
      receivedAt: new Date().toISOString(),
    });
    try {
      const { fragmentId } = await deps.reports.create(draft);
      return c.json({ reportId, fragmentId, status: "reported" }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "usable_write_failed", message }, 502);
    }
  });

  app.get("/", requireAdmin, async (c) => {
    if (!deps.reports) {
      return c.json({ error: "reports_not_configured" }, 503);
    }
    try {
      const status = c.req.query("status");
      const reports = await deps.reports.list(status ? { status } : undefined);
      return c.json({ reports, returned: reports.length });
    } catch (error) {
      console.error("[Reports] list failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "reports_unavailable" }, 503);
    }
  });

  app.get("/:id", requireAdmin, async (c) => {
    if (!deps.reports) {
      return c.json({ error: "reports_not_configured" }, 503);
    }
    try {
      const report = await deps.reports.get(c.req.param("id"));
      if (!report) return c.json({ error: "not_found" }, 404);
      return c.json(report);
    } catch (error) {
      console.error("[Reports] detail failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "reports_unavailable" }, 503);
    }
  });

  return app;
}
