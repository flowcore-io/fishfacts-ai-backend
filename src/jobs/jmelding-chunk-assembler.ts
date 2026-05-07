import * as schema from "@/db/schema";
import {
  type JMeldingAnnouncementDiscovered,
  jmeldingAnnouncementDiscoveredSchema,
} from "@/events/contracts";
import { isChunked, reassembleAnnouncement } from "@/events/jmelding-chunking";
import { eq, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import type { JMeldingFragmentProjector } from "./jmelding-fragments";

type Database = ReturnType<typeof drizzle<typeof schema>>;

const QUEUE_TTL_MS = 30 * 60 * 1000;

export class JMeldingChunkAssembler {
  constructor(
    private readonly db: Database,
    private readonly projector: JMeldingFragmentProjector,
  ) {}

  async handle(item: JMeldingAnnouncementDiscovered) {
    if (!isChunked(item)) {
      await this.projector.project(stripPartFields(item));
      return;
    }

    const totalParts = item.totalParts as number;
    const partNumber = item.partNumber as number;

    await this.db
      .insert(schema.jmeldingChunkQueue)
      .values({
        signature: item.signature,
        partNumber,
        totalParts,
        payload: item,
      })
      .onConflictDoNothing({
        target: [
          schema.jmeldingChunkQueue.signature,
          schema.jmeldingChunkQueue.partNumber,
        ],
      });

    const rows = await this.db
      .select()
      .from(schema.jmeldingChunkQueue)
      .where(eq(schema.jmeldingChunkQueue.signature, item.signature));

    if (rows.length < totalParts) return;

    const parts = rows.map((row) =>
      jmeldingAnnouncementDiscoveredSchema.parse(row.payload),
    );
    const reassembled = reassembleAnnouncement(parts);
    await this.projector.project(reassembled);

    await this.db
      .delete(schema.jmeldingChunkQueue)
      .where(eq(schema.jmeldingChunkQueue.signature, item.signature));
  }

  async cleanupExpired(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - QUEUE_TTL_MS);
    const deleted = await this.db
      .delete(schema.jmeldingChunkQueue)
      .where(lt(schema.jmeldingChunkQueue.createdAt, cutoff))
      .returning({ signature: schema.jmeldingChunkQueue.signature });
    return deleted.length;
  }
}

function stripPartFields(
  item: JMeldingAnnouncementDiscovered,
): JMeldingAnnouncementDiscovered {
  if (item.partNumber === undefined && item.totalParts === undefined) {
    return item;
  }
  return { ...item, partNumber: undefined, totalParts: undefined };
}
