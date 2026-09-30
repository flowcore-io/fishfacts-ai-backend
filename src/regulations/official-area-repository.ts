import { createHash } from "node:crypto";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

export type OfficialAreaInput = {
  caseId: string;
  paragraph: number;
  name: string | null;
  geojson: unknown;
  vertexCount: number;
};

export type OfficialArea = {
  paragraph: number;
  name: string | null;
  geojson: unknown;
  vertexCount: number;
  source: string;
  fetchedAt: Date;
};

export type OfficialAreaUpsertResult = {
  inserted: number;
  changed: number;
  unchanged: number;
};

/** Stable over the shape alone, so a re-fetch of an unchanged closure is
 * recognised as unchanged. */
export function contentHashOf(geojson: unknown): string {
  return createHash("sha256").update(JSON.stringify(geojson)).digest("hex");
}

/**
 * The authority's drawn shape per case and §. See `regulationCaseOfficialAreas`
 * for why this sits outside the revision model.
 */
export class OfficialAreaRepository {
  constructor(private readonly db: Database) {}

  /** Norwegian cases by lower-cased J-melding number (`j-153-2026`). */
  async findNorwegianCaseIds(
    jmNumbers: string[],
  ): Promise<Map<string, string>> {
    if (jmNumbers.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: schema.regulationCases.id,
        sourceRef: schema.regulationCases.sourceRef,
      })
      .from(schema.regulationCases)
      .where(
        and(
          eq(schema.regulationCases.jurisdiction, "NO"),
          inArray(
            schema.regulationCases.sourceRef,
            jmNumbers.map((n) => n.toLowerCase()),
          ),
        ),
      );
    return new Map(rows.map((row) => [row.sourceRef.toLowerCase(), row.id]));
  }

  /**
   * Insert new shapes, rewrite the ones whose content changed, and only stamp
   * `fetched_at` on the rest — a closure can be 500 KB, and rewriting it daily
   * to record that nothing moved would be pure churn.
   */
  async upsert(
    inputs: OfficialAreaInput[],
    fetchedAt: Date,
  ): Promise<OfficialAreaUpsertResult> {
    const result: OfficialAreaUpsertResult = {
      inserted: 0,
      changed: 0,
      unchanged: 0,
    };
    if (inputs.length === 0) return result;

    // One row per (case, §) is the table's key. A batch that repeats one would
    // insert twice and die on the primary key halfway through; say so up front
    // instead, and name the pair.
    const seen = new Set<string>();
    for (const input of inputs) {
      const key = `${input.caseId}:${input.paragraph}`;
      if (seen.has(key)) {
        throw new Error(
          `official areas: more than one shape for case ${input.caseId} § ${input.paragraph} in one batch`,
        );
      }
      seen.add(key);
    }

    const caseIds = [...new Set(inputs.map((input) => input.caseId))];
    const existing = await this.db
      .select({
        caseId: schema.regulationCaseOfficialAreas.caseId,
        paragraph: schema.regulationCaseOfficialAreas.paragraph,
        contentHash: schema.regulationCaseOfficialAreas.contentHash,
      })
      .from(schema.regulationCaseOfficialAreas)
      .where(inArray(schema.regulationCaseOfficialAreas.caseId, caseIds));
    const hashByKey = new Map(
      existing.map((row) => [
        `${row.caseId}:${row.paragraph}`,
        row.contentHash,
      ]),
    );

    // Atomic: a run that fails partway leaves the previous state, not a mix.
    await this.db.transaction(async (tx) => {
      for (const input of inputs) {
        const key = `${input.caseId}:${input.paragraph}`;
        const contentHash = contentHashOf(input.geojson);
        const known = hashByKey.get(key);

        if (known === undefined) {
          await tx.insert(schema.regulationCaseOfficialAreas).values({
            caseId: input.caseId,
            paragraph: input.paragraph,
            name: input.name,
            geojson: input.geojson,
            vertexCount: input.vertexCount,
            contentHash,
            fetchedAt,
          });
          result.inserted++;
        } else if (known !== contentHash) {
          await tx
            .update(schema.regulationCaseOfficialAreas)
            .set({
              name: input.name,
              geojson: input.geojson,
              vertexCount: input.vertexCount,
              contentHash,
              fetchedAt,
            })
            .where(
              and(
                eq(schema.regulationCaseOfficialAreas.caseId, input.caseId),
                eq(
                  schema.regulationCaseOfficialAreas.paragraph,
                  input.paragraph,
                ),
              ),
            );
          result.changed++;
        } else {
          await tx
            .update(schema.regulationCaseOfficialAreas)
            .set({ fetchedAt })
            .where(
              and(
                eq(schema.regulationCaseOfficialAreas.caseId, input.caseId),
                eq(
                  schema.regulationCaseOfficialAreas.paragraph,
                  input.paragraph,
                ),
              ),
            );
          result.unchanged++;
        }
      }
    });
    return result;
  }

  async listForCase(caseId: string): Promise<OfficialArea[]> {
    return await this.db
      .select({
        paragraph: schema.regulationCaseOfficialAreas.paragraph,
        name: schema.regulationCaseOfficialAreas.name,
        geojson: schema.regulationCaseOfficialAreas.geojson,
        vertexCount: schema.regulationCaseOfficialAreas.vertexCount,
        source: schema.regulationCaseOfficialAreas.source,
        fetchedAt: schema.regulationCaseOfficialAreas.fetchedAt,
      })
      .from(schema.regulationCaseOfficialAreas)
      .where(eq(schema.regulationCaseOfficialAreas.caseId, caseId))
      .orderBy(schema.regulationCaseOfficialAreas.paragraph);
  }
}
