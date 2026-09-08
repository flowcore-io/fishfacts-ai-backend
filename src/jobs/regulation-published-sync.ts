import type { Env } from "@/env";
import {
  buildPublishedCaseFragment,
  buildWithdrawnCaseFragment,
  publishedFragmentIsCurrent,
  publishedFragmentKeyFor,
  withdrawnFragmentIsCurrent,
} from "@/regulations/published-fragment";
import type { RegulationPublishedReadRepository } from "@/regulations/published-repository";
import { type UsableFragment, frontmatterFromContent } from "@/usable/client";
import type { JobExecutionResult, JobState } from "./types";

/** The slice of the Usable client this job needs, named so it can be faked. */
export type RegulationPublishedSyncUsable = {
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
 * 📖 Published-corpus sync (stage ③) — approved regulations into the
 * PUBLISHED collection, the retrieval half of what the 1st mate consumes
 * (the non-admin read API is the other half and carries the geometry).
 *
 * What is synced is the PINNED revision's view, straight from the same read
 * repository the non-admin API serves — the two channels cannot disagree.
 * Un-publish is reconciled here too: a case with an applied approval but no
 * pin anymore (a decline cleared it) gets its fragment rewritten as a
 * withdrawn tombstone with EMPTY collectionIds — leaving the collection is
 * what takes it out of retrieval's reach, the same membership-is-the-guard
 * boundary the raw corpus draws.
 *
 * Refuses to run without `REGULATION_PUBLISHED_COLLECTION_ID`: a corpus of
 * human-approved answers must never land in a guessed destination.
 */
export function createRegulationPublishedSyncJob(
  env: Env,
  usable: RegulationPublishedSyncUsable,
  repository: RegulationPublishedReadRepository,
) {
  return async function runRegulationPublishedSyncJob(
    _previous: JobState | undefined,
    args: { limit?: number },
    context: Context,
  ): Promise<JobExecutionResult> {
    const collectionId = env.REGULATION_PUBLISHED_COLLECTION_ID;
    if (!collectionId) {
      throw new Error(
        "REGULATION_PUBLISHED_COLLECTION_ID is not configured — provision the published collection first",
      );
    }
    const checkedAt = new Date().toISOString();
    const limit = args.limit ?? 200;
    const [{ regulations, total: publishedTotal }, withdrawn] =
      await Promise.all([
        repository.listPublished({ status: "all", limit, offset: 0 }),
        repository.listWithdrawn(),
      ]);
    // A capped "sync everything" run must not truncate silently: say so, so
    // an operator raises the limit instead of trusting a partial corpus.
    const truncated = publishedTotal > regulations.length;
    if (truncated) {
      console.warn(
        `[RegulationPublishedSync] TRUNCATED: ${publishedTotal} published cases, limit ${limit} — rerun with a higher limit`,
      );
    }

    const total = regulations.length + withdrawn.length;
    context.reportProgress({
      phase: "syncing-published-fragments",
      message: `${regulations.length} published + ${withdrawn.length} withdrawn to check`,
      detailsTotal: total,
    });

    let created = 0;
    let updated = 0;
    let current = 0;
    let withdrawnCount = 0;
    let failures = 0;
    let processed = 0;
    const lines: string[] = [];

    const step = () => {
      processed += 1;
      context.reportProgress({
        phase: "syncing-published-fragments",
        detailsProcessed: processed,
        detailsTotal: total,
      });
    };

    for (const item of regulations) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      try {
        const fragment = buildPublishedCaseFragment(item);
        const existing = await usable.getFragmentByKey(
          env.USABLE_WORKSPACE_ID,
          fragment.key,
        );
        if (
          existing &&
          publishedFragmentIsCurrent(
            frontmatterFromContent(existing.content),
            item,
          )
        ) {
          current += 1;
          step();
          continue;
        }
        const updateInput = {
          fragmentTypeId: env.REGULATION_RAW_FRAGMENT_TYPE_ID,
          title: fragment.title,
          summary: fragment.summary,
          content: fragment.content,
          tags: fragment.tags,
          collectionIds: [collectionId],
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
            // Same idiom as the raw sync: a 409 means the key exists even
            // though the lookup missed it, so update what the conflict names.
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
        failures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        lines.push(`${item.caseKey} — NOT SYNCED: ${detail}`);
      }
      step();
    }

    for (const item of withdrawn) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      try {
        // Only a fragment that exists needs withdrawing — a case declined
        // before any sync ran never entered the corpus.
        const existing = await usable.getFragmentByKey(
          env.USABLE_WORKSPACE_ID,
          publishedFragmentKeyFor(item.caseKey),
        );
        if (
          !existing ||
          withdrawnFragmentIsCurrent(frontmatterFromContent(existing.content))
        ) {
          step();
          continue;
        }
        const tombstone = buildWithdrawnCaseFragment(item);
        await usable.updateFragment(existing.id, {
          fragmentTypeId: env.REGULATION_RAW_FRAGMENT_TYPE_ID,
          title: tombstone.title,
          summary: tombstone.summary,
          content: tombstone.content,
          tags: tombstone.tags,
          // Leaving the collection IS the un-publish. The PATCH endpoint
          // treats a provided `collectionIds` as the DESIRED membership set
          // and removes everything not in it (verified in the API handler,
          // apps/web/src/app/api/memory-fragments/[id]/route.ts in the
          // usable repo: toRemove = current − desired) — so [] evicts;
          // only an OMITTED collectionIds leaves membership alone.
          collectionIds: [],
        });
        withdrawnCount += 1;
      } catch (error) {
        failures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        lines.push(`${item.caseKey} — NOT WITHDRAWN: ${detail}`);
      }
      step();
    }

    const summary =
      `published: ${regulations.length}${truncated ? ` of ${publishedTotal} (TRUNCATED at limit ${limit})` : ""}, ` +
      `created: ${created}, updated: ${updated}, ` +
      `already current: ${current}, withdrawn: ${withdrawnCount}, failed: ${failures}`;
    console.info("[RegulationPublishedSync]", summary);
    for (const line of lines) console.info("[RegulationPublishedSync]", line);

    return {
      checkedAt,
      changed: created + updated + withdrawnCount > 0,
      latestItems: [],
      message: summary,
    };
  };
}
