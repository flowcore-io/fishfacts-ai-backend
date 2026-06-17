import { aisPositionFixObservedSchema } from "@/events/contracts";
import type { AisClickhouseRepository } from "./clickhouse-repository";

type EventEnvelope = {
  eventId: string;
  payload: unknown;
};

/**
 * Consumes AIS position events (via the in-process pump, parallel across cluster
 * workers) and buffers them into ClickHouse. Throws on failure so the data-pump
 * retries/redelivers; idempotency is enforced by the ReplacingMergeTree.
 */
export class AisPositionProjector {
  constructor(private readonly repository: AisClickhouseRepository) {}

  async handleObserved(event: EventEnvelope): Promise<void> {
    const payload = aisPositionFixObservedSchema.parse(event.payload);
    await this.repository.enqueue(payload);
  }
}
