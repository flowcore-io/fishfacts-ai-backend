import {
  type SildelagetCatchEntryObserved,
  sildelagetCatchEntryObservedSchema,
} from "@/events/contracts";
import type { SildelagetCatchRepository } from "./repository";

type EventEnvelope = {
  eventId: string;
  payload: unknown;
};

export class SildelagetCatchProjector {
  constructor(private readonly repository: SildelagetCatchRepository) {}

  async handleObserved(event: EventEnvelope): Promise<void> {
    const payload: SildelagetCatchEntryObserved =
      sildelagetCatchEntryObservedSchema.parse(event.payload);
    await this.repository.upsertObservedEntry(event.eventId, payload);
  }
}
