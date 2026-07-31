import { randomUUID } from "node:crypto";
import { requireAdmin } from "@/auth/admin";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ReportsClient } from "./client";
import { reportSubmissionSchema, truncateSubmission } from "./contracts";
import { buildReportFragment } from "./fragment";

/** Usable fragment id. */
const FRAGMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Usable file id — a nanoid, so the URL-safe alphabet plus a length bound. */
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
      // The screenshot's `.catch(undefined)` turns a malformed or oversized
      // image into no image, which is the right trade for the report but is
      // otherwise silent: the fragment ends up saying "no screenshot" for a
      // user who ticked the box. Say it here, where it can be diagnosed.
      if (
        typeof body === "object" &&
        body !== null &&
        "screenshot" in body &&
        (body as { screenshot?: unknown }).screenshot &&
        !parsed.data.screenshot
      ) {
        console.warn("[Reports] screenshot rejected by schema, dropping it", {
          sessionId: parsed.data.sessionId,
        });
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
        // The image is a bonus on top of a report that is already written and
        // safe. If the upload fails the report stands, minus the picture —
        // the same stance the FE takes when the capture itself fails.
        //
        // "accepted", not "attached": Usable's upload is asynchronous, so a
        // 200 proves it took the bytes, not that the attachment is servable.
        // Whether it landed is answered by the attachment list on GET, which
        // is the only thing that actually knows.
        let screenshot: "accepted" | "failed" | undefined;
        if (submission.screenshot) {
          try {
            await deps.reports.attachScreenshot(
              fragmentId,
              submission.screenshot,
            );
            screenshot = "accepted";
          } catch (error) {
            console.error("[Reports] screenshot upload failed", {
              fragmentId,
              message: error instanceof Error ? error.message : String(error),
            });
            screenshot = "failed";
          }
        }
        return c.json(
          { reportId, fragmentId, status: "reported", screenshot },
          201,
        );
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

  // Screenshot bytes, proxied so the admin browser never holds a Usable
  // token. Registered before `/:id` because Hono matches in insertion order.
  app.get("/:id/attachments/:fileId", requireAdmin, async (c) => {
    if (!deps.reports) {
      return c.json({ error: "reports_not_configured" }, 503);
    }
    const id = c.req.param("id");
    const fileId = c.req.param("fileId");
    // Usable file ids are nanoids; same up-front charset discipline as the
    // fragment id, so neither reaches the upstream URL unvalidated.
    if (!FRAGMENT_ID.test(id) || !FILE_ID.test(fileId)) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const file = await deps.reports.getAttachment(id, fileId);
      if (!file) return c.json({ error: "not_found" }, 404);
      return new Response(file.body, {
        headers: {
          "content-type": file.mimeType,
          // Never render a stored file as a document in the admin origin.
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=300",
        },
      });
    } catch (error) {
      console.error("[Reports] attachment fetch failed", {
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
    if (!FRAGMENT_ID.test(id)) {
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
