import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * Read side of the admin-defined regulation groups. Strictly read-only:
 * every write to `regulation_groups` is an event with a projector, never a
 * route handler (PATHWAYS-C1).
 */

export type RegulationGroup = {
  groupId: string;
  jurisdiction: string;
  name: string;
  sortOrder: number;
  /** Non-null = retired. Admins still see it; users never do. */
  retiredAt: Date | null;
};

/** The DTO shape the group routes return — instants as ISO strings, like
 * every other regulations payload. */
export type RegulationGroupDto = {
  groupId: string;
  jurisdiction: string;
  name: string;
  sortOrder: number;
  retiredAt: string | null;
};

export function groupDto(group: RegulationGroup): RegulationGroupDto {
  return {
    groupId: group.groupId,
    jurisdiction: group.jurisdiction,
    name: group.name,
    sortOrder: group.sortOrder,
    retiredAt: group.retiredAt ? group.retiredAt.toISOString() : null,
  };
}

export class RegulationGroupRepository {
  constructor(private readonly db: Database) {}

  /** Every group of one country, retired ones included — the admin manager
   * shows what happened to a name they remember. Ordered the way the
   * manager lists them. */
  async listByJurisdiction(jurisdiction: string): Promise<RegulationGroup[]> {
    return await this.db
      .select()
      .from(schema.regulationGroups)
      .where(eq(schema.regulationGroups.jurisdiction, jurisdiction))
      .orderBy(
        asc(schema.regulationGroups.sortOrder),
        asc(schema.regulationGroups.name),
      );
  }

  /** The country's ACTIVE groups in order — what a reorder must name in
   * full and what a new group is appended after. */
  async listActive(jurisdiction: string): Promise<RegulationGroup[]> {
    return await this.db
      .select()
      .from(schema.regulationGroups)
      .where(
        and(
          eq(schema.regulationGroups.jurisdiction, jurisdiction),
          isNull(schema.regulationGroups.retiredAt),
        ),
      )
      .orderBy(
        asc(schema.regulationGroups.sortOrder),
        asc(schema.regulationGroups.name),
      );
  }

  async getById(groupId: string): Promise<RegulationGroup | null> {
    const [row] = await this.db
      .select()
      .from(schema.regulationGroups)
      .where(eq(schema.regulationGroups.groupId, groupId))
      .limit(1);
    return row ?? null;
  }

  /**
   * An ACTIVE group of the same country whose trimmed name matches
   * case-insensitively — the 409 check. Application-level rather than a DB
   * constraint on purpose: a unique index over a projection can fail a
   * replay, and the nullable `retired_at` is exactly the case that would
   * tempt `.nullsNotDistinct()` (DRIZZLE-C6).
   */
  async findActiveByName(
    jurisdiction: string,
    name: string,
  ): Promise<RegulationGroup | null> {
    const [row] = await this.db
      .select()
      .from(schema.regulationGroups)
      .where(
        and(
          eq(schema.regulationGroups.jurisdiction, jurisdiction),
          isNull(schema.regulationGroups.retiredAt),
          sql`lower(btrim(${schema.regulationGroups.name})) = lower(btrim(${name}))`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every ACTIVE group of the given countries, for the published read's
   * group resolution. Ungiven countries are not fetched: the published set
   * is read per jurisdiction filter, not globally. */
  async listActiveForJurisdictions(
    jurisdictions: string[],
  ): Promise<RegulationGroup[]> {
    if (jurisdictions.length === 0) return [];
    return await this.db
      .select()
      .from(schema.regulationGroups)
      .where(
        and(
          inArray(schema.regulationGroups.jurisdiction, jurisdictions),
          isNull(schema.regulationGroups.retiredAt),
        ),
      );
  }
}
