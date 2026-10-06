import { fetchFiskeridirPolygons } from "@/closures/fiskeridir-wfs";
import type { OfficialAreaRepository } from "@/regulations/official-area-repository";
import type { OfficialVectorPreparation } from "@/regulations/official-vector-preparation";
import type { JobExecutionResult, JobState } from "./types";

/** Refresh the diagnostic authority cache, then prepare immutable revision
 * candidates through the durable multipart event path. Preparation never
 * approves or replaces a published pin. Geometry and printed evidence remain
 * separate; all coordinate rings/parts are preserved without repair.
 * Closures absent from the current register retain their last fetched cache
 * entry and its timestamp; the register is not a historical archive.
 */

export function createFiskeridirOfficialAreasSyncJob(
  repository: OfficialAreaRepository,
  preparation?: OfficialVectorPreparation,
) {
  return async (
    _previous: JobState | undefined,
    _args: unknown,
    context: { signal: AbortSignal },
  ): Promise<JobExecutionResult> => {
    const checkedAt = new Date();
    const { polygons, skipped, merged } = await fetchFiskeridirPolygons(
      context.signal,
    );

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
              sourceMetadata: {
                sourceRef: polygon.jmNumber,
                featureIds: polygon.featureIds ?? [],
              },
            },
          ]
        : [];
    });

    const result = await repository.upsert(inputs, checkedAt);
    if (preparation)
      for (const caseId of caseIds.values()) {
        if (context.signal.aborted) throw context.signal.reason;
        try {
          await preparation.prepare(
            caseId,
            "job:fiskeridir-official-areas-sync",
          );
        } catch (error) {
          console.warn("[Fiskeridir] official revision candidate unavailable", {
            caseId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

    // The register lists every closure in force nationally while we hold a
    // subset, so this list is long every run. Name a few, count the rest.
    const UNMATCHED_SHOWN = 8;
    const unmatchedNote =
      unmatched.length === 0
        ? ""
        : ` (${unmatched.slice(0, UNMATCHED_SHOWN).join(", ")}${
            unmatched.length > UNMATCHED_SHOWN
              ? ` and ${unmatched.length - UNMATCHED_SHOWN} more`
              : ""
          })`;
    const message =
      `${result.inserted} new, ${result.changed} changed, ${result.unchanged} unchanged ` +
      `official area(s) across ${caseIds.size} case(s); ` +
      `${skipped} skipped as unusable, ${merged} repeated § merged, ` +
      `${unmatched.length} J-melding(s) in the register have no case${unmatchedNote}.`;

    // Every run, clean or not — a sync that stopped running must not look like
    // one that found nothing new (see the cross-check job for the same rule).
    console.info(`[Fiskeridir] official areas sync complete: ${message}`, {
      inserted: result.inserted,
      changed: result.changed,
      unchanged: result.unchanged,
      skipped,
      merged,
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
