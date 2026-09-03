import type { Env } from "@/env";
import type { RegulationRawSyncRepository } from "@/regulations/queue-repository";
import {
  buildRawCaseFragment,
  rawFragmentIsCurrent,
} from "@/regulations/raw-fragment";
import { type UsableFragment, frontmatterFromContent } from "@/usable/client";
import type { JobExecutionResult, JobState } from "./types";

/** The slice of the Usable client this job needs, named so it can be faked. */
export type RegulationRawSyncUsable = {
  getFragmentByKey(
    workspaceId: string,
    key: string,
  ): Promise<UsableFragment | null>;
  createFragment(input: {
    workspaceId: string;
    fragmentTypeId: string;
    key: string;
    title: string;
    summary: string;
    content: string;
    tags: string[];
    collectionIds?: string[];
  }): Promise<unknown>;
  updateFragment(
    fragmentId: string,
    input: {
      fragmentTypeId: string;
      title: string;
      summary: string;
      content: string;
      tags: string[];
      collectionIds?: string[];
    },
  ): Promise<unknown>;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/**
 * 🗂 Raw-corpus sync — parser output into the dedicated RAW collection.
 *
 * One fragment per regulation case in Fishfacts Knowledge, in the collection
 * a human provisioned for exactly this (`REGULATION_RAW_COLLECTION_ID`).
 * Collection membership is the raw/processed boundary — enforced by scoping
 * on the embed config at retrieval time, NOT by the `raw` tag, which rides
 * along for human filtering only.
 *
 * What is synced is the projection's reading — identity, statuses, parsed
 * vertices, verdict issues. The verbatim source snapshot stays in PostgreSQL,
 * where decision 6 makes it canonical; a second copy here would be a third
 * artifact to keep in sync for no gain.
 *
 * Never writes into the approved collection, from this job or anywhere else
 * in stage ①: the boundary between raw and everything user-facing is whether
 * a human has confirmed the legal text, and no code in this stage can make
 * that true.
 */
export function createRegulationRawSyncJob(
  env: Env,
  usable: RegulationRawSyncUsable,
  repository: RegulationRawSyncRepository,
) {
  return async function runRegulationRawSyncJob(
    _previous: JobState | undefined,
    args: { limit?: number },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const cases = await repository.listCases(args.limit ?? 100);

    context.reportProgress({
      phase: "syncing-raw-fragments",
      message: `${cases.length} cases to check`,
      detailsTotal: cases.length,
    });

    let created = 0;
    let updated = 0;
    let current = 0;
    let failures = 0;
    const lines: string[] = [];

    for (const [position, item] of cases.entries()) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      try {
        const geometries = await repository.listGeometries(
          item.currentRevisionId,
        );
        const fragment = buildRawCaseFragment(item, geometries);
        const existing = await usable.getFragmentByKey(
          env.USABLE_WORKSPACE_ID,
          fragment.key,
        );
        if (
          existing &&
          rawFragmentIsCurrent(frontmatterFromContent(existing.content), item)
        ) {
          current += 1;
          continue;
        }
        const updateInput = {
          fragmentTypeId: env.REGULATION_RAW_FRAGMENT_TYPE_ID,
          title: fragment.title,
          summary: fragment.summary,
          content: fragment.content,
          tags: fragment.tags,
          collectionIds: [env.REGULATION_RAW_COLLECTION_ID],
        };
        if (existing) {
          await usable.updateFragment(existing.id, updateInput);
          updated += 1;
        } else {
          try {
            await usable.createFragment({
              workspaceId: env.USABLE_WORKSPACE_ID,
              key: fragment.key,
              ...updateInput,
            });
            created += 1;
          } catch (error) {
            // Same idiom as the jmelding and POI upserters: a 409 means the
            // key exists even though the lookup missed it (the fallback list
            // is capped), so update the fragment the conflict names instead
            // of logging the same NOT SYNCED failure on every run forever.
            const message =
              error instanceof Error ? error.message : String(error);
            if (!message.includes("409")) throw error;
            const duplicate = await usable.getFragmentByKey(
              env.USABLE_WORKSPACE_ID,
              fragment.key,
            );
            if (!duplicate) throw error;
            await usable.updateFragment(duplicate.id, updateInput);
            updated += 1;
          }
        }
      } catch (error) {
        // One 502 costs one case; the next run picks it up again.
        failures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        lines.push(`${item.caseKey} — NOT SYNCED: ${detail}`);
      }

      context.reportProgress({
        phase: "syncing-raw-fragments",
        detailsProcessed: position + 1,
        detailsTotal: cases.length,
      });
    }

    const summary =
      `cases: ${cases.length}, created: ${created}, updated: ${updated}, ` +
      `already current: ${current}, failed: ${failures}`;
    console.info("[RegulationRawSync]", summary);
    for (const line of lines) console.info("[RegulationRawSync]", line);

    return {
      checkedAt,
      changed: created + updated > 0,
      latestItems: [],
      message: summary,
    };
  };
}
