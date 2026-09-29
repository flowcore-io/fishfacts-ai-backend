import {
  type OfficialClosure,
  fetchFiskeridirClosures,
} from "@/closures/fiskeridir-wfs";
import {
  type CaseDivergence,
  compareCase,
} from "@/closures/geometry-divergence";
import type { RegulationRawSyncRepository } from "@/regulations/queue-repository";
import type { JobExecutionResult, JobState } from "./types";

/**
 * 🔍 Reads Fiskeridirektoratet's published closure register and compares it
 * against the geometry we read out of the same J-melding's prose.
 *
 * Writes nothing. A divergence is reported as a log line and as the job's
 * result message, the same way the Vørn geometry typo detector surfaces a
 * source defect (`monitoring/vorn-closure-geometry-typo.monitor.yaml`) — the
 * finding needs a human to decide whether it is our parser or the statute, so
 * it belongs in front of one, not in a projection.
 *
 * What a firing means, in the order worth checking:
 *
 * 1. A typo in the statute. J-153-2026 § 32 prints `Øst 007 grader 3,.000
 *    minutter`; the authority's own vertex list says `7 38,000`. We read the
 *    malformed number as 3.0 and placed the corner 29 km away.
 * 2. A closure the statute bounds with open lines plus the coastline. The
 *    authority's list then carries vertices the text never prints, so the
 *    counts differ legitimately and the area is not drawable from prose at all.
 * 3. A parser defect.
 *
 * Silence means every closure we read matches the authority's own list
 * position for position — NOT that the map is right, which is a different
 * claim about a different geometry (see `fiskeridir-wfs.ts`).
 */

const NO_JURISDICTION = "NO";

/**
 * The case projector lower-cases the J-melding number into `sourceRef`
 * (`j-153-2026`); the register publishes it as printed (`J-153-2026`). Joining
 * them verbatim matches nothing and reports a clean bill of health, so both
 * sides are folded before they meet.
 */
function jmKey(jmNumber: string): string {
  return jmNumber.trim().toUpperCase();
}

/** Cases to read per run. The Norwegian corpus is well under this. */
const CASE_SCAN_LIMIT = 500;

export function createFiskeridirWfsCrosscheckJob(
  repository: RegulationRawSyncRepository,
) {
  return async (
    _previous: JobState | undefined,
    _args: unknown,
    context: { signal: AbortSignal },
  ): Promise<JobExecutionResult> => {
    const checkedAt = new Date().toISOString();
    const official = await fetchFiskeridirClosures(context.signal);
    const byJmNumber = new Map<string, OfficialClosure[]>();
    for (const closure of official) {
      const key = jmKey(closure.jmNumber);
      const existing = byJmNumber.get(key);
      if (existing) existing.push(closure);
      else byJmNumber.set(key, [closure]);
    }

    const cases = await repository.listCases(CASE_SCAN_LIMIT);
    const norwegian = cases.filter(
      (row) => row.jurisdiction === NO_JURISDICTION,
    );

    const divergences: CaseDivergence[] = [];
    let compared = 0;
    let notPublished = 0;

    for (const row of norwegian) {
      const officialAreas = byJmNumber.get(jmKey(row.sourceRef));
      if (!officialAreas) {
        // In force elsewhere, superseded, or never carried geometry — the
        // register holds current closures only, so absence is not a finding.
        notPublished++;
        continue;
      }
      if (!row.currentRevisionId) continue;
      const ours = await repository.listGeometries(row.currentRevisionId);
      compared++;
      const divergence = compareCase(jmKey(row.sourceRef), officialAreas, ours);
      if (!divergence) continue;
      divergences.push(divergence);

      if (divergence.areaCountDetail) {
        console.warn(
          `[Fiskeridir] closure geometry diverges: ${divergence.jmNumber} — ${divergence.areaCountDetail}`,
          { jmNumber: divergence.jmNumber, caseKey: row.caseKey },
        );
      }
      for (const area of divergence.areas) {
        console.warn(
          `[Fiskeridir] closure geometry diverges: ${divergence.jmNumber} § ${area.paragraph ?? "?"} — ${area.kind}: ${area.detail}`,
          {
            jmNumber: divergence.jmNumber,
            caseKey: row.caseKey,
            paragraph: area.paragraph,
            officialName: area.officialName,
            kind: area.kind,
          },
        );
      }
    }

    const divergentAreas = divergences.reduce(
      (total, d) => total + (d.areaCountDetail ? 1 : d.areas.length),
      0,
    );
    const message =
      divergences.length === 0
        ? `${compared} Norwegian announcement(s) match the authority's published vertices; ${notPublished} not in the register.`
        : `${divergences.length} of ${compared} Norwegian announcement(s) diverge from the authority's published vertices (${divergentAreas} finding(s)); ${notPublished} not in the register.`;

    return {
      checkedAt,
      // Read-only: nothing is written, so nothing changed. `changed` drives
      // re-emit bookkeeping for collectors, and this is not one.
      changed: false,
      latestItems: divergences.map((d) => ({
        signature: `${d.jmNumber}:${d.areaCountDetail ?? d.areas.length}`,
        title: d.areaCountDetail
          ? `${d.jmNumber}: ${d.areaCountDetail}`
          : `${d.jmNumber}: ${d.areas.length} area(s) diverge`,
        url: `https://www.fiskeridir.no/yrkesfiske/j-meldinger/${d.jmNumber}`,
        status: "unknown" as const,
        jmNumber: d.jmNumber,
        lastCheckedAt: checkedAt,
      })),
      message,
    };
  };
}
