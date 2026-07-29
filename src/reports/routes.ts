import { randomUUID } from "node:crypto";
import { requireAdmin } from "@/auth/admin";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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

  // 5 MB is far above the FE's clipped capture (~1.5 MB worst case) but
  // stops an authenticated client from posting a default-limit (128 MB)
  // body that would be fully parsed before truncation.
  app.post(
    "/",
    bodyLimit({
      maxSize: 5 * 1024 * 1024,
      // Same JSON error shape as every other failure on this route.
      // The unread body MUST be cancelled before responding: answering
      // with megabytes still in flight tears down the whole Bun server
      // (silent process death observed on bun 1.3.3).
      onError: async (c) => {
        await c.req.raw.arrayBuffer().catch(() => {});
        return c.json({ error: "payload_too_large" }, 413);
      },
    }),
    async (c) => {
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
      // Browser-side ring-buffer clips count toward the same accounting.
      truncation.clippedValues += parsed.data.feClippedValues ?? 0;
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
        // Log the upstream detail server-side only — Usable error bodies can
        // echo workspace/fragment-type internals (same posture as the GETs).
        console.error("[Reports] create failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "usable_write_failed" }, 502);
      }
    },
  );

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
    // Fragment ids are UUIDs; rejecting anything else up front keeps
    // arbitrary strings out of the upstream Usable URL entirely.
    const id = c.req.param("id");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const report = await deps.reports.get(id);
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
