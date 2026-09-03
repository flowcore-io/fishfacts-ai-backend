/**
 * Regulation cases as a projection of the announcement pathway.
 *
 * The four collectors already emit everything they parse as
 * `JMeldingAnnouncementDiscovered` events, so the approval queue is not a
 * second ingest — it is a second READING of the same durable record, sitting
 * beside `jmelding_geo` the way the fragment index does. Replaying the pathway
 * rebuilds the queue with its full history; nothing here can invent a fact the
 * event stream does not carry.
 *
 * One case per law/notice, keyed by the source's own identifier. Each observed
 * version of the text becomes a REVISION (addressable — a stage ② approval
 * names one), and each revision carries its own geometry rows and its own raw
 * source snapshot. Re-delivery of a signature already projected is a no-op
 * beyond freshness stamps; changed content appends a revision rather than
 * editing anything in place.
 *
 * The per-source coordinate grammars stay where they are: pre-parsed FO/IS
 * areas are taken as given (with the same Vørn ring normalisation the geo
 * projector applies, and the same statute exemption from it), and Norwegian
 * bodies go through `parseJmeldingGeo` — the same reader, so the queue and the
 * map cannot disagree about what a body says.
 */

import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import { parseJmeldingGeo } from "@/jmelding/geo-parser";
import { parseValidityEnd, parseValidityStart } from "@/jmelding/validity";
import { normalizeVornAreas } from "@/jmelding/vorn-ring";
import { jmeldingFragmentKey } from "@/jobs/jmelding-fragments";
import { and, eq, sql } from "drizzle-orm";
import { caseIdFor, geometryIdFor, revisionIdFor } from "./ids";

/**
 * Recorded on every revision as `parser_version`. Bump when the projection's
 * reading of an announcement changes, so a re-parse pass can find the rows
 * written under the old reading.
 */
export const CASE_PROJECTION_VERSION = "case-projection/1";

export type RegulationSourceType =
  | "logasavn"
  | "vorn-veidibann"
  | "fiskeridir-jmelding"
  | "fiskistofa-wfs";

export type CaseProjectionResult = {
  caseId: string;
  caseKey: string;
  revisionId: string;
  outcome: "created" | "revised" | "replayed" | "skipped";
};

/**
 * Which collector's grammar produced an announcement.
 *
 * Statute-derived events are recognisable two ways — the `LOG-K-` row key and
 * `sourceFragmentId` — and both are checked so a statute is never mistaken for
 * a Vørn ban (whose rings get repaired; a statute's must not be).
 */
export function sourceTypeOf(
  item: JMeldingAnnouncementDiscovered,
): RegulationSourceType {
  if (item.jmNumber?.startsWith("LOG-K-") || item.sourceFragmentId) {
    return "logasavn";
  }
  if (item.region === "FO") return "vorn-veidibann";
  if (item.region === "IS") return "fiskistofa-wfs";
  return "fiskeridir-jmelding";
}

function multipointWkt(points: Array<{ lat: number; lon: number }>) {
  if (points.length === 0) return null;
  const inner = points
    .map((p) => `${p.lon.toFixed(6)} ${p.lat.toFixed(6)}`)
    .join(",");
  return `MULTIPOINT(${inner})`;
}

function instantOf(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class RegulationCaseProjector {
  constructor(private readonly db: Database) {}

  async project(
    item: JMeldingAnnouncementDiscovered,
  ): Promise<CaseProjectionResult> {
    const sourceType = sourceTypeOf(item);
    // Same fallback identity the geo projector uses, so an announcement is
    // either a case in both stores or a case in neither.
    const sourceRef =
      item.jmNumber ??
      jmeldingFragmentKey(item.url, {
        region: item.region,
        jmNumber: item.jmNumber,
      });
    const caseKey = `${sourceType}:${sourceRef}`;
    const caseId = caseIdFor(caseKey);
    const revisionId = revisionIdFor(item.signature);

    if (!item.jmNumber && item.status === "unknown") {
      return { caseId, caseKey, revisionId, outcome: "skipped" };
    }

    // The same geometry reading the geo projector performs, area by area.
    let areas = item.areas;
    let geometrySource: "preparsed" | "enumerated" = "preparsed";
    if (
      areas &&
      areas.length > 0 &&
      item.region === "FO" &&
      !item.sourceFragmentId
    ) {
      areas = normalizeVornAreas(areas).areas;
    }
    if (!areas || areas.length === 0) {
      areas = parseJmeldingGeo(item.bodyMarkdown).areas;
      geometrySource = "enumerated";
    }

    const checkedAt = instantOf(item.checkedAt) ?? new Date();
    const effectiveFrom = instantOf(parseValidityStart(item.validFrom));
    const effectiveTo = instantOf(parseValidityEnd(item.validTo));

    return await this.db.transaction(async (tx) => {
      const existingRevision = await tx
        .select({ id: schema.regulationCaseRevisions.id })
        .from(schema.regulationCaseRevisions)
        .where(eq(schema.regulationCaseRevisions.id, revisionId));
      if (existingRevision.length > 0) {
        // Replay of a signature already projected — the record is already
        // faithful, only the freshness stamp moves.
        await tx
          .update(schema.regulationCases)
          .set({
            lastCheckedAt: sql`GREATEST(${schema.regulationCases.lastCheckedAt}, ${checkedAt.toISOString()}::timestamptz)`,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.regulationCases.id, caseId));
        return { caseId, caseKey, revisionId, outcome: "replayed" as const };
      }

      const existingCase = await tx
        .select({
          id: schema.regulationCases.id,
          firstSeenAt: schema.regulationCases.firstSeenAt,
        })
        .from(schema.regulationCases)
        .where(eq(schema.regulationCases.id, caseId));
      const isNewCase = existingCase.length === 0;
      const changeType = isNewCase ? "new" : "amendment";

      const positionRows = await tx
        .select({
          max: sql<
            number | null
          >`max(${schema.regulationCaseRevisions.position})`,
        })
        .from(schema.regulationCaseRevisions)
        .where(eq(schema.regulationCaseRevisions.caseId, caseId));
      const position = (positionRows[0]?.max ?? -1) + 1;

      await tx.insert(schema.regulationCaseRevisions).values({
        id: revisionId,
        caseId,
        position,
        contentHash: item.contentHash ?? null,
        changeType,
        author: `collector:${sourceType}`,
        snapshotText: item.bodyMarkdown === "" ? null : item.bodyMarkdown,
        snapshotUrl: item.url,
        snapshotFetchedAt: checkedAt,
        snapshotFragmentId: item.sourceFragmentId ?? null,
        parserVersion: CASE_PROJECTION_VERSION,
        sourceEventSignature: item.signature,
      });

      for (const [index, area] of areas.entries()) {
        const wkt = multipointWkt(area.points);
        await tx.insert(schema.regulationCaseGeometries).values({
          id: geometryIdFor(revisionId, index),
          caseId,
          revisionId,
          position: index,
          name: area.name ?? null,
          points: area.points,
          geom: wkt ? (sql`ST_GeomFromText(${wkt}, 4326)` as never) : null,
          geometrySource,
        });
      }

      const caseFields = {
        title: item.title,
        sourceUrl: item.url,
        category: item.category ?? null,
        summary: item.summary ?? null,
        sourceStatus: item.status,
        publishedAt: instantOf(item.publishedAt),
        effectiveFrom,
        effectiveTo,
        changeType,
        contentHash: item.contentHash ?? null,
        currentRevisionId: revisionId,
        lastCheckedAt: checkedAt,
        // A new text invalidates the old verdict — the queue must re-ask.
        verdictStatus: "pending",
      };

      if (isNewCase) {
        await tx.insert(schema.regulationCases).values({
          id: caseId,
          caseKey,
          sourceType,
          sourceRef,
          jurisdiction: item.region,
          detectedBy: `collector:${sourceType}`,
          firstSeenAt: checkedAt,
          ...caseFields,
        });
        await tx.insert(schema.regulationCaseSources).values({
          caseId,
          sourceType,
          sourceRef,
          url: item.url,
          isPrimary: true,
          firstSeenAt: checkedAt,
          lastCheckedAt: checkedAt,
        });
      } else {
        await tx
          .update(schema.regulationCases)
          .set({ ...caseFields, updatedAt: sql`now()` })
          .where(eq(schema.regulationCases.id, caseId));
        await tx
          .update(schema.regulationCaseSources)
          .set({ lastCheckedAt: checkedAt })
          .where(
            and(
              eq(schema.regulationCaseSources.caseId, caseId),
              eq(schema.regulationCaseSources.isPrimary, true),
            ),
          );
      }

      return {
        caseId,
        caseKey,
        revisionId,
        outcome: isNewCase ? ("created" as const) : ("revised" as const),
      };
    });
  }
}
