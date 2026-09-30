import { fetchFiskeridirPolygons } from "@/closures/fiskeridir-wfs";
import type { OfficialAreaRepository } from "@/regulations/official-area-repository";
import type { JobExecutionResult, JobState } from "./types";

/**
 * 🗺 Stores Fiskeridirektoratet's drawn shape for every closure that belongs to
 * a case we hold, so the review screen can show a reviewer the same polygon
 * the authority's own map shows.
 *
 * Why this exists: a statute's coordinates are not always its whole shape.
 * § 6 of the seinot forskrift lists eight positions and then says the boundary
 * follows the coastline between two pairs of them; the text carries no
 * coordinates for that. The authority resolves it into a coastline-clipped
 * polygon with holes for islands, and no text reader can — so the reviewer
 * compares against theirs, and this is where it comes from. The vertices we
 * read out of the prose stay exactly as they are; this is a second, separate
 * thing shown beside them.
 *
 * Writes only `regulation_case_official_areas`. Touches no revision, so it
 * cannot reset a validation or demote an approved case. Stores the shape as
 * published: nothing simplified, nothing repaired, and a shape that fails the
 * plausibility check is skipped and counted rather than fixed.
 *
 * The register lists closures IN FORCE. A closure that drops out of it (J-155
 * became J-158, for one) keeps the last shape stored, stamped with when it was
 * last seen.
 */

export function createFiskeridirOfficialAreasSyncJob(
  repository: OfficialAreaRepository,
) {
  return async (
    _previous: JobState | undefined,
    _args: unknown,
    context: { signal: AbortSignal },
  ): Promise<JobExecutionResult> => {
    const checkedAt = new Date();
    const { polygons, skipped } = await fetchFiskeridirPolygons(context.signal);

    const jmNumbers = [...new Set(polygons.map((p) => p.jmNumber))];
    const caseIds = await repository.findNorwegianCaseIds(jmNumbers);

    const unmatched = jmNumbers.filter((n) => !caseIds.has(n.toLowerCase()));
    const inputs = polygons.flatMap((polygon) => {
      const caseId = caseIds.get(polygon.jmNumber.toLowerCase());
      return caseId
        ? [
            {
              caseId,
              paragraph: polygon.paragraph,
              name: polygon.name,
              geojson: polygon.geometry,
              vertexCount: polygon.vertexCount,
            },
          ]
        : [];
    });

    const result = await repository.upsert(inputs, checkedAt);

    const message =
      `${result.inserted} new, ${result.changed} changed, ${result.unchanged} unchanged ` +
      `official area(s) across ${caseIds.size} case(s); ` +
      `${skipped} skipped as unusable, ${unmatched.length} J-melding(s) in the register have no case${
        unmatched.length > 0 ? ` (${unmatched.join(", ")})` : ""
      }.`;

    // Every run, clean or not — a sync that stopped running must not look like
    // one that found nothing new (see the cross-check job for the same rule).
    console.info(`[Fiskeridir] official areas sync complete: ${message}`, {
      inserted: result.inserted,
      changed: result.changed,
      unchanged: result.unchanged,
      skipped,
      unmatched: unmatched.length,
    });

    return {
      checkedAt: checkedAt.toISOString(),
      changed: result.inserted + result.changed > 0,
      latestItems: [],
      message,
    };
  };
}
