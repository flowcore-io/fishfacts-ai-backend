import {
  API_ERROR,
  invalidQuery,
  notFound,
  serviceUnavailable,
} from "@/http/errors";
import { Hono } from "hono";
import { z } from "zod";
import type { RegulationPublishedReadRepository } from "./published-repository";
import { CASE_ID } from "./routes";

const listQuerySchema = z.object({
  /** `?jurisdiction=FO,NO` — passed through, an unknown code just matches
   * nothing (jurisdictions come from the collectors, not a fixed enum). */
  jurisdiction: z
    .string()
    .transform((value) => value.split(",").filter((entry) => entry.length > 0))
    .optional(),
  status: z.enum(["current", "all"]).default("current"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PublishedRegulationsRouterDeps = {
  published: RegulationPublishedReadRepository;
};

/**
 * The published regulations read API (stage ③) — the ONE non-admin surface
 * under /api/regulations, mounted at /api/regulations/published ahead of the
 * admin router. Authenticated (X-Auth-Token via the app-level middleware)
 * but deliberately NOT requireAdmin: it serves only cases a human approved,
 * and only the revision the approval pinned — this is what the user-facing
 * 1st mate's parent tools and map layers read. Strictly read-only; there is
 * no publish route anywhere, because an applied approval IS the publish.
 */
export function createPublishedRegulationsRouter(
  deps: PublishedRegulationsRouterDeps,
): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return invalidQuery(c, { issues: parsed.error.issues });
    }
    try {
      const { regulations, total } = await deps.published.listPublished(
        parsed.data,
      );
      return c.json({
        regulations,
        returned: regulations.length,
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    } catch (error) {
      console.error("[Regulations] published list failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.publishedUnavailable);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    try {
      // An un-published or never-published case is a plain 404 — this
      // surface must not reveal that a case exists in the admin queue.
      const regulation = await deps.published.getPublished(id.toLowerCase());
      if (!regulation) return notFound(c);
      return c.json(regulation);
    } catch (error) {
      console.error("[Regulations] published detail failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.publishedUnavailable);
    }
  });

  return app;
}
