import type * as schema from "@/db/schema";
import { genericEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { FlowcoreEventEnvelope, GenericEventInput } from "./contracts";

export type GenericEventRecord = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceEventId: string;
  validTime: string;
};

export interface GenericEventRepository {
  upsertFromEvent(
    event: FlowcoreEventEnvelope<GenericEventInput>,
  ): Promise<void>;
  findById(id: string): Promise<GenericEventRecord | null>;
}

export class PostgresGenericEventRepository implements GenericEventRepository {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async upsertFromEvent(
    event: FlowcoreEventEnvelope<GenericEventInput>,
  ): Promise<void> {
    await this.db
      .insert(genericEvents)
      .values({
        id: event.payload.id,
        kind: event.payload.kind,
        payload: event.payload.payload,
        metadata: event.payload.metadata,
        sourceEventId: event.eventId,
        validTime: new Date(event.validTime),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: genericEvents.id,
        set: {
          kind: event.payload.kind,
          payload: event.payload.payload,
          metadata: event.payload.metadata,
          sourceEventId: event.eventId,
          validTime: new Date(event.validTime),
          updatedAt: new Date(),
        },
      });
  }

  async findById(id: string): Promise<GenericEventRecord | null> {
    const rows = await this.db
      .select()
      .from(genericEvents)
      .where(eq(genericEvents.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      payload: row.payload as Record<string, unknown>,
      metadata: row.metadata as Record<string, unknown>,
      sourceEventId: row.sourceEventId,
      validTime: row.validTime.toISOString(),
    };
  }
}

export class InMemoryGenericEventRepository implements GenericEventRepository {
  private readonly rows = new Map<string, GenericEventRecord>();

  async upsertFromEvent(
    event: FlowcoreEventEnvelope<GenericEventInput>,
  ): Promise<void> {
    this.rows.set(event.payload.id, {
      id: event.payload.id,
      kind: event.payload.kind,
      payload: event.payload.payload,
      metadata: event.payload.metadata,
      sourceEventId: event.eventId,
      validTime: event.validTime,
    });
  }

  async findById(id: string): Promise<GenericEventRecord | null> {
    return this.rows.get(id) ?? null;
  }
}
