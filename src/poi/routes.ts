import { isAdmin, requireAdmin } from "@/auth/admin";
import { poiCreatedSchema } from "@/events/contracts";
import type { PathwayWriter } from "@/pathways";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { ZodError, type z } from "zod";
import type { PoiRepository } from "./repository";

/**
 * The event payload minus the attribution: `verifiedBy`/`verifiedAt` are
 * deliberately NOT accepted here — the route stamps them from the
 * authenticated admin + server clock, so a durable POI's attribution can
 * never be forged by the caller (the poisoning surface the whole write path
 * is designed around).
 */
const createInputSchema = poiCreatedSchema.omit({
  verifiedBy: true,
  verifiedAt: true,
});

export type PoiRouterDeps = {
  repository: PoiRepository;
  writer: PathwayWriter;
  /** Auth applies to the WRITE side only — the GET is public reference data
   * like /api/gebco, so the router scopes auth per-route instead of app.ts
   * blanketing the /api/poi prefix. */
  authMiddleware: MiddlewareHandler;
};

export function createPoiRouter(deps: PoiRouterDeps): Hono {
  const app = new Hono();

  // Point-of-Interest gazetteer — named lighthouses/landmarks the FE's
  // draw_regulation_boundary resolves narrative boundary vertices against.
  // Public reference data like /api/gebco; read from the editable Usable POI
  // fragments (short in-process cache) so non-developers can extend the
  // gazetteer without a code change + deploy.
  app.get("/", async (c) => {
    try {
      const pois = await deps.repository.list();
      return c.json({ pois, returned: pois.length });
    } catch (error) {
      console.error("[POI] gazetteer fetch failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "poi_unavailable" }, 503);
    }
  });

  app.post("/", deps.authMiddleware, requireAdmin, async (c) => {
    const auth = c.get("auth");
    // Service-layer re-check (belt & braces, per IDOR fragment).
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    let parsed: z.infer<typeof createInputSchema>;
    try {
      parsed = createInputSchema.parse(await c.req.json());
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_payload", issues: error.issues }, 400);
      }
      return c.json({ error: "invalid_payload" }, 400);
    }
    const verifiedAt = new Date().toISOString();
    try {
      const eventId = await deps.writer.writePoiCreated({
        key: parsed.key,
        title: parsed.title,
        lat: parsed.lat,
        lng: parsed.lng,
        aliases: parsed.aliases,
        source: parsed.source,
        verifiedBy: auth.user.username,
        verifiedAt,
      });
      return c.json({ key: parsed.key, eventId, verifiedAt }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  return app;
}
