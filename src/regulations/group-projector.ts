import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type {
  RegulationGroupCreated,
  RegulationGroupRenamed,
  RegulationGroupReordered,
  RegulationGroupRetired,
} from "@/events/contracts";
import { and, eq, isNull } from "drizzle-orm";

/**
 * The only writer of `regulation_groups` — the admin-defined navigation
 * layer under each country. Four events, four handlers, each idempotent
 * under replay:
 *
 * - created: an insert that yields to whatever is already there, so a
 *   redelivery never overwrites the renames that followed it.
 * - renamed / retired: last-write-wins on a single row, which is the right
 *   semantics for a label an admin sets; an unknown id is logged and
 *   skipped rather than thrown, so one stray event cannot stall the pump
 *   (a full replay re-lands it in order).
 * - reordered: rewrites `sort_order` from the array index, scoped to the
 *   named country, so the resulting order is self-contained.
 */
export class RegulationGroupProjector {
  constructor(private readonly db: Database) {}

  async handleCreated(payload: RegulationGroupCreated): Promise<void> {
    await this.db
      .insert(schema.regulationGroups)
      .values({
        groupId: payload.groupId,
        jurisdiction: payload.jurisdiction,
        name: payload.name,
        sortOrder: payload.sortOrder,
        createdAt: new Date(payload.recordedAt),
        updatedAt: new Date(payload.recordedAt),
      })
      // Creation is the one event whose replay must NOT clobber: the row it
      // would rewrite already carries every rename and reorder since.
      .onConflictDoNothing();
  }

  async handleRenamed(payload: RegulationGroupRenamed): Promise<void> {
    const updated = await this.db
      .update(schema.regulationGroups)
      .set({ name: payload.name, updatedAt: new Date(payload.recordedAt) })
      .where(eq(schema.regulationGroups.groupId, payload.groupId))
      .returning({ groupId: schema.regulationGroups.groupId });
    if (updated.length === 0) {
      console.warn("[RegulationGroup] rename for an unknown group", {
        groupId: payload.groupId,
      });
    }
  }

  async handleReordered(payload: RegulationGroupReordered): Promise<void> {
    // One transaction: a half-applied order is an order no replay would
    // produce. Scoped to the named country so a group id from elsewhere in
    // the list cannot drag another country's ordering with it.
    await this.db.transaction(async (tx) => {
      for (const [position, groupId] of payload.groupIds.entries()) {
        await tx
          .update(schema.regulationGroups)
          .set({
            sortOrder: position,
            updatedAt: new Date(payload.recordedAt),
          })
          .where(
            and(
              eq(schema.regulationGroups.groupId, groupId),
              eq(schema.regulationGroups.jurisdiction, payload.jurisdiction),
            ),
          );
      }
    });
  }

  async handleRetired(payload: RegulationGroupRetired): Promise<void> {
    // Only an ACTIVE group is retired: redelivering the event must not move
    // the timestamp that records when the admin actually retired it.
    const updated = await this.db
      .update(schema.regulationGroups)
      .set({
        retiredAt: new Date(payload.recordedAt),
        updatedAt: new Date(payload.recordedAt),
      })
      .where(
        and(
          eq(schema.regulationGroups.groupId, payload.groupId),
          isNull(schema.regulationGroups.retiredAt),
        ),
      )
      .returning({ groupId: schema.regulationGroups.groupId });
    if (updated.length === 0) {
      console.warn("[RegulationGroup] retire hit no active group", {
        groupId: payload.groupId,
      });
    }
  }
}
