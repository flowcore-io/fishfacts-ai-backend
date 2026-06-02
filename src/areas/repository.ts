import type { Database } from "@/db/client";
import { areas } from "@/db/schema";
import type { AreaGeometry, AreaGeometryType } from "@/events/contracts";
import { and, asc, eq, isNull, type sql } from "drizzle-orm";

export type AreaRecord = {
  id: string;
  name: string;
  groupName: string;
  geometryType: AreaGeometryType;
  geometry: AreaGeometry;
  color: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type AdminAreaRow = typeof areas.$inferSelect;

function rowToRecord(row: AdminAreaRow): AreaRecord {
  return {
    id: row.id,
    name: row.name,
    groupName: row.groupName ?? "Ungrouped",
    geometryType: row.geometryType as AreaGeometryType,
    geometry: row.geometry as AreaGeometry,
    color: row.color,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AreasRepository {
  constructor(private readonly db: Database) {}

  async listActive(): Promise<AreaRecord[]> {
    const rows = await this.db
      .select()
      .from(areas)
      .where(isNull(areas.deletedAt))
      .orderBy(asc(areas.name));
    return rows.map(rowToRecord);
  }

  async findById(id: string): Promise<AreaRecord | null> {
    const rows = await this.db
      .select()
      .from(areas)
      .where(and(eq(areas.id, id), isNull(areas.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }

  async exists(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: areas.id })
      .from(areas)
      .where(eq(areas.id, id))
      .limit(1);
    return rows.length > 0;
  }

  async insertCreated(input: {
    id: string;
    name: string;
    groupName: string;
    geometryType: AreaGeometryType;
    geometry: AreaGeometry;
    color: string | null;
    notes: string | null;
    createdBy: string;
    createdAt: Date;
    sourceEventId: string;
  }): Promise<void> {
    await this.db
      .insert(areas)
      .values({
        id: input.id,
        name: input.name,
        groupName: input.groupName,
        geometryType: input.geometryType,
        geometry: input.geometry as unknown as Record<string, unknown>,
        color: input.color,
        notes: input.notes,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        deletedAt: null,
        sourceEventId: input.sourceEventId,
      })
      .onConflictDoNothing({ target: areas.id });
  }

  async applyPatch(input: {
    id: string;
    patch: {
      name?: string;
      groupName?: string;
      geometryType?: AreaGeometryType;
      geometry?: AreaGeometry;
      color?: string | null;
      notes?: string | null;
    };
    updatedAt: Date;
    sourceEventId: string;
  }): Promise<void> {
    const set: Record<string, unknown> = {
      updatedAt: input.updatedAt,
      sourceEventId: input.sourceEventId,
    };
    if (input.patch.name !== undefined) set.name = input.patch.name;
    if (input.patch.groupName !== undefined)
      set.groupName = input.patch.groupName;
    if (input.patch.geometryType !== undefined)
      set.geometryType = input.patch.geometryType;
    if (input.patch.geometry !== undefined)
      set.geometry = input.patch.geometry as unknown as Record<string, unknown>;
    if (input.patch.color !== undefined) set.color = input.patch.color;
    if (input.patch.notes !== undefined) set.notes = input.patch.notes;
    await this.db
      .update(areas)
      .set(set)
      .where(and(eq(areas.id, input.id), isNull(areas.deletedAt)));
  }

  async softDelete(input: {
    id: string;
    deletedAt: Date;
    sourceEventId: string;
  }): Promise<void> {
    await this.db
      .update(areas)
      .set({
        deletedAt: input.deletedAt,
        updatedAt: input.deletedAt,
        sourceEventId: input.sourceEventId,
      })
      .where(and(eq(areas.id, input.id), isNull(areas.deletedAt)));
  }

  // raw SELECT helper kept available for potential future bbox queries
  async raw(query: ReturnType<typeof sql>) {
    return this.db.execute(query);
  }
}
