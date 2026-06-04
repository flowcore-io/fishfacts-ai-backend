import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import { parseSildelagetCatchWorkbook } from "@/sildelaget/catch-parser";
import type { SildelagetCatchRepository } from "@/sildelaget/repository";
import {
  collectSildelagetRouteKeys,
  enrichSildelagetEntriesWithRouteAreas,
  fetchSildelagetRouteAreas,
} from "@/sildelaget/route-areas";
import type { JobExecutionResult, JobLatestItem, JobState } from "./types";

type Args = {
  selectedTime: number;
  selectedSpecies: string;
  selectedCatchType: string;
  isNor: boolean;
  backfill?: boolean;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    itemsDiscovered?: number;
    detailsProcessed?: number;
    detailsTotal?: number;
    skippedExisting?: number;
  }) => void;
  checkpoint?: (
    update: (state: { job: JobState; updatedAt: string }) => void,
  ) => Promise<void>;
};

export function createSildelagetCatchJournalJob(
  env: Env,
  writer: PathwayWriter,
  repository: SildelagetCatchRepository,
) {
  return async function runSildelagetCatchJournalJob(
    previous: JobState | undefined,
    args: Args,
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const sourceUrl = buildExportUrl(
      env.SILDELAGET_CATCHJOURNAL_EXPORT_URL,
      args,
    );

    context.reportProgress({
      phase: "loading-existing-hashes",
      message: "Loading projected Sildelaget catch hashes",
    });
    const existingHashes = await repository.getEntryHashes();

    context.reportProgress({
      phase: "fetching-export",
      message: "Fetching Sildelaget catch journal Excel export",
    });
    const response = await fetch(sourceUrl, {
      headers: {
        "user-agent": "FishFactsJobs/1.0",
        accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
      },
      signal: context.signal,
    });
    if (!response.ok) {
      throw new Error(`Sildelaget catch journal HTTP ${response.status}`);
    }

    const entries = await parseSildelagetCatchWorkbook(
      await response.arrayBuffer(),
      { sourceUrl, checkedAt },
    );
    const changedEntries = args.backfill
      ? entries
      : entries.filter(
          (entry) => existingHashes.get(entry.innmeldingId) !== entry.entryHash,
        );
    const routeKeys = collectSildelagetRouteKeys(changedEntries);
    const entriesToEmit =
      routeKeys.size > 0
        ? enrichSildelagetEntriesWithRouteAreas(
            changedEntries,
            await loadRouteAreas(env.SILDELAGET_CATCHMAP_AREAS_URL, context),
          )
        : changedEntries;
    const skippedExisting = entries.length - changedEntries.length;

    context.reportProgress({
      phase: "emitting-events",
      message: `Emitting ${entriesToEmit.length}/${entries.length} ${
        args.backfill ? "backfill" : "changed"
      } catch entries`,
      itemsDiscovered: entries.length,
      detailsProcessed: 0,
      detailsTotal: entriesToEmit.length,
      skippedExisting,
    });

    const latestItems: JobLatestItem[] = [];
    for (let index = 0; index < entriesToEmit.length; index += 1) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const entry = entriesToEmit[index];
      await writer.writeSildelagetCatchEntryObserved(entry);
      latestItems.push(toLatestItem(entry));
      await context.checkpoint?.((state) => {
        state.job.progress = {
          phase: "emitting-events",
          message: `Emitted ${index + 1}/${entriesToEmit.length} ${
            args.backfill ? "backfill" : "changed"
          } catch entries (${skippedExisting} skipped unchanged)`,
          itemsDiscovered: entries.length,
          detailsProcessed: index + 1,
          detailsTotal: entriesToEmit.length,
          skippedExisting,
          updatedAt: new Date().toISOString(),
        };
      });
    }

    return {
      checkedAt,
      changed: entriesToEmit.length > 0,
      latestItems:
        latestItems.length > 0
          ? latestItems.slice(0, 25)
          : (previous?.latestItems ?? []),
      message:
        entriesToEmit.length > 0
          ? `Parsed ${entries.length} Sildelaget entries; emitted ${entriesToEmit.length} ${
              args.backfill ? "backfill" : "changed"
            } entries`
          : `Parsed ${entries.length} Sildelaget entries; no changes`,
    };
  };
}

async function loadRouteAreas(sourceUrl: string, context: Context) {
  context.reportProgress({
    phase: "fetching-route-areas",
    message: "Fetching Sildelaget catch map route areas",
  });
  return fetchSildelagetRouteAreas(sourceUrl, context.signal);
}

function buildExportUrl(baseUrl: string, args: Args): string {
  const url = new URL(baseUrl);
  url.searchParams.set("selectedTime", String(args.selectedTime));
  url.searchParams.set("selectedSpecies", args.selectedSpecies);
  url.searchParams.set("selectedCatchType", args.selectedCatchType);
  url.searchParams.set("isNor", String(args.isNor));
  return url.toString();
}

function toLatestItem(
  entry: Awaited<ReturnType<typeof parseSildelagetCatchWorkbook>>[number],
): JobLatestItem {
  return {
    signature: entry.entryHash,
    title: [entry.innmeldingId, entry.vesselName].filter(Boolean).join(" "),
    url: entry.sourceUrl,
    status: "current",
    createdAt: entry.reportedDate
      ? `${entry.reportedDate}T00:00:00.000Z`
      : undefined,
    jmNumber: entry.innmeldingId,
    contentHash: entry.entryHash,
    lastCheckedAt: entry.checkedAt,
  };
}
