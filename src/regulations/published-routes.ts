import {
  API_ERROR,
  errorResponse,
  invalidQuery,
  notFound,
  serviceUnavailable,
} from "@/http/errors";
import { Hono } from "hono";
import { z } from "zod";
import type {
  PublishedRegulation,
  RegulationPublishedReadRepository,
} from "./published-repository";
import { GeometryClientUpgradeError } from "./published-repository";
import { CASE_ID } from "./routes";

const version = z
  .enum(["1", "2"])
  .default("1")
  .transform((v) => Number(v) as 1 | 2);
const listQuerySchema = z.object({
  geometryVersion: version,
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
  const exactQuery = z.object({
    geometryVersion: version,
    expectedPublishedRevisionId: z.string().uuid().toLowerCase().optional(),
    expectedSnapshotManifestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  });
  const changed = (
    result: PublishedRegulation,
    expected: z.infer<typeof exactQuery>,
  ) =>
    (expected.expectedPublishedRevisionId &&
      result.publishedRevisionId !== expected.expectedPublishedRevisionId) ||
    (expected.expectedSnapshotManifestHash &&
      result.snapshotManifestHash !== expected.expectedSnapshotManifestHash);

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

  app.get("/source/fiskeridir-jmelding/:sourceRef", async (c) => {
    const parsed = exactQuery.safeParse(c.req.query());
    if (!parsed.success)
      return invalidQuery(c, { issues: parsed.error.issues });
    try {
      const result = await deps.published.getPublishedSource(
        c.req.param("sourceRef"),
        parsed.data.geometryVersion,
      );
      if (result && changed(result, parsed.data))
        return c.json(
          {
            error: "published_snapshot_changed",
            currentPublishedRevisionId: result.publishedRevisionId,
            currentSnapshotManifestHash: result.snapshotManifestHash ?? null,
          },
          409,
        );
      return result ? c.json(result) : notFound(c);
    } catch (error) {
      if (error instanceof GeometryClientUpgradeError)
        return errorResponse(c, 409, API_ERROR.geometryClientUpgradeRequired, {
          requiredGeometryVersion: 2,
        });
      return serviceUnavailable(c, API_ERROR.publishedUnavailable);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!CASE_ID.test(id)) return notFound(c);
    const parsed = exactQuery.safeParse(c.req.query());
    if (!parsed.success)
      return invalidQuery(c, { issues: parsed.error.issues });
    try {
      // An un-published or never-published case is a plain 404 — this
      // surface must not reveal that a case exists in the admin queue.
      const regulation = await deps.published.getPublished(
        id.toLowerCase(),
        parsed.data.geometryVersion,
      );
      if (!regulation) return notFound(c);
      if (changed(regulation, parsed.data))
        return c.json(
          {
            error: "published_snapshot_changed",
            currentPublishedRevisionId: regulation.publishedRevisionId,
            currentSnapshotManifestHash:
              regulation.snapshotManifestHash ?? null,
          },
          409,
        );
      return c.json(regulation);
    } catch (error) {
      if (error instanceof GeometryClientUpgradeError)
        return errorResponse(c, 409, API_ERROR.geometryClientUpgradeRequired, {
          requiredGeometryVersion: 2,
        });
      console.error("[Regulations] published detail failed", {
        caseId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      return serviceUnavailable(c, API_ERROR.publishedUnavailable);
    }
  });

  return app;
}
