import { randomUUID } from "node:crypto";
import { isAdmin, requireAdmin } from "@/auth/admin";
import { areaGeometrySchema, areaGeometryTypeSchema } from "@/events/contracts";
import type { PathwayWriter } from "@/pathways";
import { Hono } from "hono";
import { ZodError, z } from "zod";
import type { AreasRepository } from "./repository";

const createInputSchema = z.object({
  name: z.string().min(1).max(120),
  groupName: z.string().min(1).max(80),
  geometryType: areaGeometryTypeSchema,
  geometry: areaGeometrySchema,
  color: z.string().min(1).max(32).optional(),
  notes: z.string().max(2000).optional(),
});

const updateInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    groupName: z.string().min(1).max(80).optional(),
    geometryType: areaGeometryTypeSchema.optional(),
    geometry: areaGeometrySchema.optional(),
    color: z.string().min(1).max(32).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, {
    message: "patch must include at least one field",
  });

export type AreasRouterDeps = {
  repository: AreasRepository;
  writer: PathwayWriter;
};

export function createAreasRouter(deps: AreasRouterDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await deps.repository.listActive();
    return c.json({ rows });
  });

  app.get("/:id", async (c) => {
    const record = await deps.repository.findById(c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json(record);
  });

  app.post("/", requireAdmin, async (c) => {
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
    const areaId = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      const eventId = await deps.writer.writeAreaCreated({
        areaId,
        name: parsed.name,
        groupName: parsed.groupName,
        geometryType: parsed.geometryType,
        geometry: parsed.geometry,
        color: parsed.color,
        notes: parsed.notes,
        createdBy: auth.user.username,
        createdAt,
      });
      return c.json({ areaId, eventId }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  app.put("/:id", requireAdmin, async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const areaId = c.req.param("id");
    const existing = await deps.repository.findById(areaId);
    if (!existing) return c.json({ error: "not_found" }, 404);
    let patch: z.infer<typeof updateInputSchema>;
    try {
      patch = updateInputSchema.parse(await c.req.json());
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json({ error: "invalid_payload", issues: error.issues }, 400);
      }
      return c.json({ error: "invalid_payload" }, 400);
    }
    const updatedAt = new Date().toISOString();
    try {
      const eventId = await deps.writer.writeAreaUpdated({
        areaId,
        patch,
        updatedBy: auth.user.username,
        updatedAt,
      });
      return c.json({ areaId, eventId }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  app.delete("/:id", requireAdmin, async (c) => {
    const auth = c.get("auth");
    if (!isAdmin(auth.user.authorities)) {
      return c.json({ error: "forbidden", reason: "admin_required" }, 403);
    }
    const areaId = c.req.param("id");
    const existing = await deps.repository.findById(areaId);
    if (!existing) return c.json({ error: "not_found" }, 404);
    const deletedAt = new Date().toISOString();
    try {
      const eventId = await deps.writer.writeAreaDeleted({
        areaId,
        deletedBy: auth.user.username,
        deletedAt,
      });
      return c.json({ areaId, eventId }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  return app;
}
