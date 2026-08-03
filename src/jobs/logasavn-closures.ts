import type { Env } from "@/env";
import type { JMeldingGeoRepository } from "@/jmelding/geo-repository";
import { extractAreas, isDrawable } from "@/logasavn/areas";
import {
  type ClosureSource,
  LOGASAVN_KEY_PREFIX,
  planClosureIngest,
} from "@/logasavn/closures";
import type { LogasavnReviewRepository } from "@/logasavn/review-repository";
import { IN_FORCE, hashBody } from "@/logasavn/sweep";
import type { PathwayWriter } from "@/pathways";
import { type UsableApiClient, bodyFromContent } from "@/usable/client";
import type { JobExecutionResult, JobState } from "./types";

const FETCH_CONCURRENCY = 6;

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    itemsDiscovered?: number;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/** Frontmatter fields the closure key is built from. */
function stringish(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * 🇫🇴 Lógasavn closures → the shared geo store.
 *
 * The last mile of the statutory-closures work: `draw_regulations` reads
 * `jmelding_geo` by region, so an approved Faroese statute landing there with
 * `region: "FO"` and geometry shows up on the map with no frontend change.
 *
 * Only APPROVED, current, in-force rows are considered, and each one's text is
 * re-hashed at draw time before anything is emitted — see `planClosureIngest`
 * for why all three conditions are load-bearing.
 *
 * Emits on the shared announcement pathway rather than writing the read model
 * directly, so these closures get the same event log, replay and projection as
 * the Vørn and Fiskistofa collectors. `sourceFragmentId` tells the assembler not
 * to write a fragment copy: the Lógasavn mirror is the record, this is a derived
 * index over it.
 */
export function createLogasavnClosuresJob(
  env: Env,
  writer: PathwayWriter,
  usable: UsableApiClient,
  reviewRepository: LogasavnReviewRepository,
  geoRepository: JMeldingGeoRepository,
) {
  return async function runLogasavnClosuresJob(
    _previous: JobState | undefined,
    _args: Record<string, never>,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();

    context.reportProgress({
      phase: "loading-approvals",
      message: "Loading approved Lógasavn statutes",
    });
    const approved = (
      await reviewRepository.listForReview({ status: "approved" })
    ).filter((row) => row.validityStatus === IN_FORCE);
    const alreadyDrawn =
      await geoRepository.listLogasavnRows(LOGASAVN_KEY_PREFIX);

    context.reportProgress({
      phase: "re-reading-sources",
      message: `Re-reading ${approved.length} approved statutes`,
      itemsDiscovered: approved.length,
    });

    // Re-fetch every approved statute rather than trusting the swept copy: the
    // hash check below is only worth anything if it runs against the text as it
    // reads NOW.
    const sources: ClosureSource[] = [];
    for (let start = 0; start < approved.length; start += FETCH_CONCURRENCY) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const batch = approved.slice(start, start + FETCH_CONCURRENCY);
      const fetched = await Promise.all(
        batch.map(async (row) => {
          const fragment = await usable
            .getFragmentById(row.fragmentId, env.LOGASAVN_WORKSPACE_ID)
            .catch(() => null);
          if (!fragment) {
            return { row, body: null, contentHash: null, areas: [] };
          }
          const body = bodyFromContent(fragment.content);
          return {
            row,
            body,
            contentHash: hashBody(body),
            documentType: stringish(fragment.frontmatter?.document_type),
            lawNumber: stringish(fragment.frontmatter?.law_number),
            year: stringish(fragment.frontmatter?.year),
            url: stringish(fragment.frontmatter?.url) ?? "",
            areas: extractAreas(body).filter(isDrawable),
          } satisfies ClosureSource;
        }),
      );
      sources.push(...fetched);
    }

    const plan = planClosureIngest(
      sources,
      alreadyDrawn.map((row) => ({
        key: row.jmNumber,
        fragmentId: row.fragmentId,
      })),
    );
    // Printed every run: "approved: 12, drawn: 12" becoming "approved: 12,
    // drawn: 0" is the whole system failing closed, and it is only visible if
    // the numbers are always there.
    const counts =
      `approved in force: ${approved.length}, drawn: ${plan.emit.length}, ` +
      `withheld: ${plan.skip.length}, retracted: ${plan.retract.length}`;
    console.info("[LogasavnClosures]", counts);
    for (const skipped of plan.skip) {
      console.warn("[LogasavnClosures] withheld", skipped);
    }

    for (const closure of plan.emit) {
      await writer.writeJMeldingAnnouncement({
        signature: `${closure.key}:${closure.contentHash}`,
        title: closure.title,
        url: closure.url,
        status: "current",
        jmNumber: closure.key,
        region: "FO",
        category: "lógasavn friðing (statutory closure)",
        areas: closure.areas,
        bodyMarkdown: "",
        contentHash: closure.contentHash,
        sourceFragmentId: closure.fragmentId,
        recurrence: closure.recurrence ?? undefined,
        checkedAt,
      });
    }

    // Retractions ride the same pathway so the read model stays a projection of
    // events rather than something two writers disagree about.
    const drawnByKey = new Map(alreadyDrawn.map((row) => [row.jmNumber, row]));
    for (const key of plan.retract) {
      const existing = drawnByKey.get(key);
      if (!existing) continue;
      await writer.writeJMeldingAnnouncement({
        signature: `${key}:retracted:${checkedAt}`,
        title: existing.title,
        url: existing.url,
        status: "archived",
        jmNumber: key,
        region: "FO",
        bodyMarkdown: "",
        checkedAt,
      });
    }

    return {
      checkedAt,
      changed: plan.emit.length > 0 || plan.retract.length > 0,
      latestItems: [],
      message: counts,
    };
  };
}
