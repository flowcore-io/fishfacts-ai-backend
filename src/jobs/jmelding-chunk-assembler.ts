import * as schema from "@/db/schema";
import {
  type JMeldingAnnouncementDiscovered,
  jmeldingAnnouncementDiscoveredSchema,
} from "@/events/contracts";
import { isChunked, reassembleAnnouncement } from "@/events/jmelding-chunking";
import type { JMeldingGeoProjector } from "@/jmelding/geo-projector";
import { eq, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import type { JMeldingFragmentProjector } from "./jmelding-fragments";

type Database = ReturnType<typeof drizzle<typeof schema>>;

const QUEUE_TTL_MS = 30 * 60 * 1000;

export class JMeldingChunkAssembler {
  constructor(
    private readonly db: Database,
    private readonly projector: JMeldingFragmentProjector,
    private readonly geoProjector?: JMeldingGeoProjector,
  ) {}

  async handle(item: JMeldingAnnouncementDiscovered) {
    if (!isChunked(item)) {
      await this.runProjectors(stripPartFields(item));
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
    await this.runProjectors(reassembled);

    await this.db
      .delete(schema.jmeldingChunkQueue)
      .where(eq(schema.jmeldingChunkQueue.signature, item.signature));
  }

  private async runProjectors(item: JMeldingAnnouncementDiscovered) {
    let fragmentId: string | null = null;
    if (item.sourceFragmentId) {
      // The source already lives in Usable and we do not own it (Lógasavn).
      // Writing our own copy would duplicate the law and give us two records to
      // keep in step, so the geo row points straight at theirs. The trade is
      // that these closures are absent from the J-announcement semantic index —
      // accepted deliberately; `draw_regulations` is the path that matters.
      fragmentId = item.sourceFragmentId;
    } else {
      try {
        const result = await this.projector.project(item);
        fragmentId = result?.fragmentId ?? null;
      } catch (error) {
        console.error("[JMeldingFragment] projection failed", {
          jmNumber: item.jmNumber,
          url: item.url,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!this.geoProjector) return;
    try {
      await this.geoProjector.project(item, fragmentId);
    } catch (error) {
      console.error("[JMeldingGeo] projection failed", {
        jmNumber: item.jmNumber,
        url: item.url,
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
