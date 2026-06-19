import { createHash } from "node:crypto";
import type { ClosureRecord } from "@/closures/scrapers";
import {
  fetchVornBan,
  listVornBanUrls,
  vornSourceKey,
} from "@/closures/scrapers";
import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import { jmeldingFragmentKey } from "./jmelding-fragments";
import type { JobExecutionResult, JobLatestItem, JobState } from "./types";

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
    knownItems?: number;
    skippedExisting?: number;
  }) => void;
  checkpoint?: (
    update: (state: { job: JobState; updatedAt: string }) => void,
  ) => Promise<void>;
};

/** Map closure status → the J-melding announcement status enum. */
function toAnnouncementStatus(
  status: ClosureRecord["status"],
): JobLatestItem["status"] {
  if (status === "active") return "current";
  if (status === "archived") return "archived";
  return "unknown";
}

function signatureFor(record: ClosureRecord): string {
  // The pathway treats `signature` as the idempotency key — a re-emit with an
  // unchanged signature is suppressed. Include every projected field that can
  // change (title, status, validity, geometry) so corrections re-deliver.
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceKey: record.sourceKey,
        title: record.title,
        status: record.status,
        category: record.closureType ?? "",
        validFrom: record.validFrom ?? "",
        validTo: record.validTo ?? "",
        bbox: record.bbox ?? null,
        points: record.points.length,
      }),
    )
    .digest("hex");
}

function closureToLatestItem(
  record: ClosureRecord,
  checkedAt: string,
): JobLatestItem {
  return {
    signature: signatureFor(record),
    title: record.title,
    url: record.url ?? "",
    status: toAnnouncementStatus(record.status),
    jmNumber: record.sourceKey,
    validFrom: record.validFrom,
    validTo: record.validTo,
    category: record.closureType,
    bodyMarkdown: record.bodyMarkdown,
    lastCheckedAt: checkedAt,
  };
}

/**
 * 🇫🇴 Vørn — bráðfeingis veiðibann (emergency trawl-ban) collector. The ban
 * pages are immutable historical records that only ever grow, so this is a
 * pure incremental crawl: list all ban URLs, skip the ones already in Usable
 * (by fragment key), fetch + parse only the new ones, and emit them onto the
 * shared J-melding announcement pathway with `region: "FO"` + pre-parsed
 * geometry. They land in the same geo store as Norwegian J-meldinger and are
 * returned by the shared `search_regulations`/`get_regulation` tools.
 */
export function createVornVeidibannJob(
  _env: Env,
  writer: PathwayWriter,
  options?: { loadKnownKeys?: () => Promise<Set<string>> },
) {
  return async function runVornVeidibannJob(
    previous: JobState | undefined,
    args: { maxItems: number; refreshExisting?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    context.reportProgress({
      phase: "crawling-listings",
      message: "Listing Vørn veiðibann pages",
    });
    const urls = await listVornBanUrls();
    context.reportProgress({
      phase: "loading-known-fragments",
      message: `Found ${urls.length} ban pages; loading known fragments`,
      itemsDiscovered: urls.length,
    });
    const knownKeys = args.refreshExisting
      ? new Set<string>()
      : await (options?.loadKnownKeys?.() ??
          Promise.resolve(new Set<string>()));

    const fragmentKeyFor = (url: string) =>
      jmeldingFragmentKey(url, { region: "FO", jmNumber: vornSourceKey(url) });

    const unseen = urls
      .filter((url) => !knownKeys.has(fragmentKeyFor(url)))
      .slice(0, args.maxItems);
    const skippedExisting = urls.length - unseen.length;
    context.reportProgress({
      phase: "filtering-known-fragments",
      message: `${unseen.length}/${urls.length} bans need events (${skippedExisting} known)`,
      itemsDiscovered: urls.length,
      knownItems: knownKeys.size,
      skippedExisting,
    });

    if (unseen.length === 0) {
      return {
        checkedAt,
        changed: false,
        latestItems: previous?.latestItems ?? [],
        message: `All ${urls.length} Vørn bans already ingested; no events emitted`,
      };
    }

    const latestItems: JobLatestItem[] = [];
    for (let start = 0; start < unseen.length; start += FETCH_CONCURRENCY) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const batch = unseen.slice(start, start + FETCH_CONCURRENCY);
      const records = await Promise.all(
        batch.map((url) => fetchVornBan(url).catch(() => null)),
      );
      for (const record of records) {
        if (!record) continue;
        await writer.writeJMeldingAnnouncement({
          signature: signatureFor(record),
          title: record.title,
          url: record.url ?? "",
          status: toAnnouncementStatus(record.status),
          jmNumber: record.sourceKey,
          validFrom: record.validFrom,
          validTo: record.validTo,
          category: record.closureType,
          region: "FO",
          areas:
            record.points.length > 0
              ? [
                  {
                    name: record.title,
                    points: record.points.map((p) => ({
                      lat: p.lat,
                      lon: p.lng,
                    })),
                  },
                ]
              : undefined,
          bodyMarkdown: record.bodyMarkdown,
          checkedAt,
        });
        latestItems.push(closureToLatestItem(record, checkedAt));
      }
      context.reportProgress({
        phase: "emitting-events",
        message: `Emitted ${latestItems.length}/${unseen.length} Vørn bans`,
        detailsProcessed: latestItems.length,
        detailsTotal: unseen.length,
        knownItems: knownKeys.size,
        skippedExisting,
      });
    }

    return {
      checkedAt,
      changed: latestItems.length > 0,
      latestItems: [...latestItems, ...(previous?.latestItems ?? [])].slice(
        0,
        25,
      ),
      message: `Emitted ${latestItems.length} new Vørn veiðibann closures (${skippedExisting} already known)`,
    };
  };
}
