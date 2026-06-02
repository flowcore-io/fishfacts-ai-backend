import type { AreaCreated, AreaDeleted, AreaUpdated } from "@/events/contracts";
import type { AreasRepository } from "./repository";

type EventEnvelope = {
  eventId: string;
};

export class AreasProjector {
  constructor(private readonly repo: AreasRepository) {}

  async handleCreated(
    event: EventEnvelope,
    payload: AreaCreated,
  ): Promise<void> {
    try {
      if (await this.repo.exists(payload.areaId)) {
        return;
      }
      await this.repo.insertCreated({
        id: payload.areaId,
        name: payload.name,
        groupName: payload.groupName,
        geometryType: payload.geometryType,
        geometry: payload.geometry,
        color: payload.color ?? null,
        notes: payload.notes ?? null,
        createdBy: payload.createdBy,
        createdAt: new Date(payload.createdAt),
        sourceEventId: event.eventId,
      });
    } catch (error) {
      console.error("[Areas] created handler failed", {
        areaId: payload.areaId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async handleUpdated(
    event: EventEnvelope,
    payload: AreaUpdated,
  ): Promise<void> {
    try {
      await this.repo.applyPatch({
        id: payload.areaId,
        patch: payload.patch,
        updatedAt: new Date(payload.updatedAt),
        sourceEventId: event.eventId,
      });
    } catch (error) {
      console.error("[Areas] updated handler failed", {
        areaId: payload.areaId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async handleDeleted(
    event: EventEnvelope,
    payload: AreaDeleted,
  ): Promise<void> {
    try {
      await this.repo.softDelete({
        id: payload.areaId,
        deletedAt: new Date(payload.deletedAt),
        sourceEventId: event.eventId,
      });
    } catch (error) {
      console.error("[Areas] deleted handler failed", {
        areaId: payload.areaId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
