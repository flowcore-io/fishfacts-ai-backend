import { createHash } from "node:crypto";
import type { Env } from "@/env";
import { withExpiry } from "@/jmelding/validity";
import type { PathwayWriter } from "@/pathways";
import { jmeldingFragmentKey } from "./jmelding-fragments";
import type { JobExecutionResult, JobLatestItem, JobState } from "./types";

const FETCH_CONCURRENCY = 10;

type CandidateItem = {
  title: string;
  url: string;
  status: JobLatestItem["status"];
  publishedAt?: string;
  validFrom?: string;
  validTo?: string;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    pagesProcessed?: number;
    pagesTotal?: number;
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

function stripTags(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeUrl(raw: string, baseUrl: string) {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function extractDate(text: string) {
  return text.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/)?.[1];
}

function toIsoDateStart(value?: string) {
  if (!value) return undefined;
  const normalized = value.trim();
  const match = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!match) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

const ARCHIVED_MARKERS = [
  "utgått",
  "utgatt",
  "utgaatt",
  "historisk",
  "avsluttet",
  "arkiv",
  "expired",
];
// "Kommende" is a notice that has been adopted but whose window starts later.
// It is live and not superseded, so it files as current; `valid_from` is what
// keeps it out of "in force right now" reads.
const CURRENT_MARKERS = ["gjeldende", "gjeldande", "kommende", "current"];

/**
 * Classify a notice from a status SIGNAL — its own `Status` field, or the
 * listing link text, which ends with the status word ("… Utløpsdato
 * 31.12.2023 Utgått"). Never pass a whole page body: every J-melding page
 * carries "Se utgåtte meldinger" in its footer and a great many carry
 * "Gjeldende" in ordinary legal prose ("§ 3 oppheves. Gjeldende §§ 4 og 5 blir
 * §§ 3 og 4." — J-99-2025), so a body scan misclassifies in both directions
 * depending only on which marker is tested first.
 *
 * Within a signal an archived marker wins: an explicit "Utgått" is a statement
 * about this notice, whereas a current marker can still be prose.
 */
export function detectStatus(text: string, fallback: JobLatestItem["status"]) {
  const lower = text.toLowerCase();
  if (ARCHIVED_MARKERS.some((marker) => lower.includes(marker))) {
    return "archived";
  }
  if (CURRENT_MARKERS.some((marker) => lower.includes(marker))) {
    return "current";
  }
  return fallback;
}

/**
 * Read one `<dt>label</dt><dd>value</dd>` pair out of the `fd-datalist` header
 * that opens every J-melding page — the notice's own metadata, as opposed to
 * anything the statute text happens to say. Date cells wrap the value in
 * `<time datetime="2025-07-21">`, which is preferred over the rendered
 * day-first text.
 */
export function extractDataListValue(
  html: string,
  label: string,
): string | undefined {
  const cell = html.match(
    new RegExp(
      `<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`,
      "i",
    ),
  )?.[1];
  if (!cell) return undefined;
  const isoDate = cell.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  return isoDate ?? (decodeEntities(stripTags(cell)) || undefined);
}

function extractJMeldingNumber(text: string) {
  const match = text.toLowerCase().match(/\bj-(\d+)-(\d{4})\b/);
  return match ? `j-${match[1]}-${match[2]}` : undefined;
}

/**
 * Pull the validity window out of Fiskeridir text. The end date is labelled
 * "Gyldig til og med" on a notice still in force and "Utløpsdato" once it has
 * expired — matching only `gyldig til` (as this did) left every expired notice
 * with no end date at all, so nothing could contradict its status keyword.
 */
export function extractValidity(text: string) {
  return {
    validFrom: text.match(
      /gyldig\s+fra(?:\s+og\s+med)?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    )?.[1],
    validTo: text.match(
      /(?:gyldig\s+til(?:\s+og\s+med)?|utløpsdato|utlopsdato)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    )?.[1],
  };
}

function detectCategory(title: string, bodyText: string) {
  return `${title} ${bodyText}`
    .match(/fisket\s+etter\s+([a-zæøå\- ]{2,40})/i)?.[1]
    ?.trim()
    .replace(/\s+/g, " ");
}

function signatureFor(item: CandidateItem & { contentHash?: string }) {
  return createHash("sha256")
    .update(
      `${item.title}::${item.url}::${item.status}::${item.publishedAt ?? ""}::${item.validFrom ?? ""}::${item.validTo ?? ""}::${item.contentHash ?? ""}`,
    )
    .digest("hex");
}

function isJMeldingLink(url: string, title: string) {
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();
  return (
    lowerUrl.includes("/yrkesfiske/j-meldinger/j-") ||
    /\bj-\d+-\d{4}\b/.test(lowerTitle) ||
    lowerTitle.includes("j-melding")
  );
}

function parseLinks(
  html: string,
  baseUrl: string,
  fallbackStatus: JobLatestItem["status"],
) {
  const matches = [
    ...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ];
  const deduped = new Map<string, CandidateItem>();
  for (const match of matches) {
    const href = normalizeUrl(match[1], baseUrl);
    const title = decodeEntities(stripTags(match[2]));
    if (!title || !isJMeldingLink(href, title)) continue;
    // The link text is the whole listing row — number, heading, validity
    // window and status word ("J-114-2023 Forskrift … Gyldig fra og med
    // 07.07.2023 Utløpsdato 31.12.2023 Utgått"). Classify from that alone; the
    // surrounding markup this used to include belongs to the neighbouring rows.
    const validity = extractValidity(title);
    deduped.set(href, {
      title,
      url: href,
      status: withExpiry(detectStatus(title, fallbackStatus), validity.validTo),
      publishedAt: extractDate(title),
      ...validity,
    });
  }
  return Array.from(deduped.values());
}

function parseMaxPage(html: string) {
  return [...html.matchAll(/[?&]page=(\d+)/gi)].reduce(
    (max, match) => Math.max(max, Number(match[1]) || 1),
    1,
  );
}

function extractMainHtml(html: string) {
  return html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
}

function htmlToMarkdown(html: string) {
  const blocks = [...html.matchAll(/<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi)];
  const lines: string[] = [];
  for (const block of blocks) {
    const tag = block[1].toLowerCase();
    const text = decodeEntities(stripTags(block[2]));
    if (!text) continue;
    if (tag === "h1") lines.push(`# ${text}`, "");
    else if (tag === "h2") lines.push(`## ${text}`, "");
    else if (tag === "h3") lines.push(`### ${text}`, "");
    else if (tag === "li") lines.push(`- ${text}`);
    else lines.push(text, "");
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || decodeEntities(stripTags(html))
  );
}

async function collectListing(input: {
  baseUrl: string;
  maxPages: number;
  signal: AbortSignal;
  reportProgress: Context["reportProgress"];
}) {
  const candidates = new Map<string, CandidateItem>();
  console.log(
    `[FiskeridirJob] collectListing: fetching page 1 ${input.baseUrl}`,
  );
  const firstStart = Date.now();
  const first = await fetch(input.baseUrl, {
    headers: { "user-agent": "FishFactsJobs/1.0", accept: "text/html" },
    signal: input.signal,
  });
  console.log(
    `[FiskeridirJob] collectListing: page 1 done in ${Date.now() - firstStart}ms (status ${first.status})`,
  );
  if (!first.ok) throw new Error(`Fiskeridir listing HTTP ${first.status}`);
  const firstHtml = await first.text();
  const maxPage = Math.min(input.maxPages, parseMaxPage(firstHtml));
  for (const item of parseLinks(firstHtml, input.baseUrl, "unknown")) {
    candidates.set(item.url, item);
  }
  console.log(
    `[FiskeridirJob] collectListing: maxPage=${maxPage}, items after page 1: ${candidates.size}`,
  );
  input.reportProgress({
    phase: "crawling-listings",
    message: `Crawled 1/${maxPage} pages (${candidates.size} items found)`,
    pagesProcessed: 1,
    pagesTotal: maxPage,
    itemsDiscovered: candidates.size,
  });
  for (let page = 2; page <= maxPage; page += 1) {
    const pageUrl = `${input.baseUrl}${input.baseUrl.includes("?") ? "&" : "?"}page=${page}`;
    const pageStart = Date.now();
    console.log(
      `[FiskeridirJob] collectListing: fetching page ${page}/${maxPage}`,
    );
    const response = await fetch(pageUrl, {
      headers: { "user-agent": "FishFactsJobs/1.0", accept: "text/html" },
      signal: input.signal,
    });
    const pageMs = Date.now() - pageStart;
    if (!response.ok) {
      console.warn(
        `[FiskeridirJob] collectListing: page ${page} HTTP ${response.status} in ${pageMs}ms — skipping`,
      );
      continue;
    }
    if (pageMs > 5000) {
      console.warn(
        `[FiskeridirJob] collectListing: page ${page} SLOW ${pageMs}ms (>5s)`,
      );
    }
    for (const item of parseLinks(
      await response.text(),
      input.baseUrl,
      "unknown",
    )) {
      candidates.set(item.url, item);
    }
    if (page % 25 === 0 || page === maxPage) {
      console.log(
        `[FiskeridirJob] collectListing: page ${page}/${maxPage} done in ${pageMs}ms, ${candidates.size} items so far`,
      );
    }
    input.reportProgress({
      phase: "crawling-listings",
      message: `Crawled ${page}/${maxPage} pages (${candidates.size} items found)`,
      pagesProcessed: page,
      pagesTotal: maxPage,
      itemsDiscovered: candidates.size,
    });
  }
  console.log(
    `[FiskeridirJob] collectListing: done, ${candidates.size} unique items from ${maxPage} pages`,
  );
  return Array.from(candidates.values());
}

async function fetchDetail(
  item: CandidateItem,
  signal: AbortSignal,
): Promise<JobLatestItem> {
  let bodyMarkdown = "";
  let contentHash = "";
  let pageStatus = item.status;
  let publishedAt = item.publishedAt;
  let jmNumber = extractJMeldingNumber(`${item.url} ${item.title}`);
  let validFrom = item.validFrom;
  let validTo = item.validTo;
  let category: string | undefined;
  const response = await fetch(item.url, {
    headers: { "user-agent": "FishFactsJobs/1.0", accept: "text/html" },
    signal,
  }).catch(() => null);
  if (response?.ok) {
    const mainHtml = extractMainHtml(await response.text());
    const bodyText = decodeEntities(stripTags(mainHtml));
    bodyMarkdown = htmlToMarkdown(mainHtml);
    contentHash = createHash("sha256")
      .update(bodyText.slice(0, 6000))
      .digest("hex");
    // The page's own metadata header, in preference to anything in the body:
    // `Status`, and the end date under whichever label applies.
    const fieldStatus = extractDataListValue(mainHtml, "Status");
    const fieldValidFrom = extractDataListValue(mainHtml, "Gyldig fra og med");
    const fieldValidTo =
      extractDataListValue(mainHtml, "Gyldig til og med") ??
      extractDataListValue(mainHtml, "Utløpsdato");
    publishedAt = publishedAt ?? extractDate(bodyText);
    jmNumber = jmNumber ?? extractJMeldingNumber(`${item.title} ${bodyText}`);
    const validity = extractValidity(item.title);
    validFrom = fieldValidFrom ?? validity.validFrom ?? validFrom;
    validTo = fieldValidTo ?? validity.validTo ?? validTo;
    pageStatus = withExpiry(
      detectStatus(fieldStatus ?? item.title, pageStatus),
      validTo,
    );
    category = detectCategory(item.title, bodyText);
  }
  return {
    signature: signatureFor({
      ...item,
      status: pageStatus,
      publishedAt,
      validFrom,
      validTo,
      contentHash,
    }),
    title: item.title,
    url: item.url,
    status: pageStatus,
    publishedAt,
    createdAt: toIsoDateStart(publishedAt ?? validFrom),
    jmNumber,
    validFrom,
    validTo,
    category,
    bodyMarkdown,
    contentHash,
  };
}

function rankByJMeldingId(a: CandidateItem, b: CandidateItem) {
  const value = (item: CandidateItem) => {
    const match = `${item.url} ${item.title}`
      .toLowerCase()
      .match(/j-(\d+)-(\d{4})/);
    return match ? Number(match[2]) * 100000 + Number(match[1]) : -1;
  };
  return value(b) - value(a);
}

export function createFiskeridirJMeldingerJob(
  env: Env,
  writer: PathwayWriter,
  options?: { loadKnownKeys?: () => Promise<Set<string>> },
) {
  return async function runFiskeridirJMeldingerJob(
    previous: JobState | undefined,
    args: {
      maxItems: number;
      maxPages: number;
      includeArchived: boolean;
      refreshExisting?: boolean;
    },
    context: Context,
  ): Promise<JobExecutionResult> {
    const jobStart = Date.now();
    const checkedAt = new Date().toISOString();
    console.log(
      `[FiskeridirJob] starting run: maxItems=${args.maxItems}, maxPages=${args.maxPages}, includeArchived=${args.includeArchived}, refreshExisting=${args.refreshExisting ?? false}, baseUrl=${env.FISKERIDIR_JMELDINGER_BASE_URL}`,
    );
    const listingStart = Date.now();
    const candidates = await collectListing({
      baseUrl: env.FISKERIDIR_JMELDINGER_BASE_URL,
      maxPages: args.maxPages,
      signal: context.signal,
      reportProgress: context.reportProgress,
    });
    console.log(
      `[FiskeridirJob] listing collected: ${candidates.length} candidates in ${Date.now() - listingStart}ms`,
    );
    const ranked = (
      args.includeArchived
        ? candidates
        : candidates.filter((item) => item.status !== "archived")
    )
      .sort(rankByJMeldingId)
      .slice(0, args.maxItems);
    if (ranked.length === 0) {
      throw new Error("No J-meldinger items could be parsed from source page");
    }
    context.reportProgress({
      phase: "loading-known-fragments",
      message: "Loading existing J-melding fragments from Usable",
      pagesProcessed: Math.min(args.maxPages, 1),
      pagesTotal: args.maxPages,
      itemsDiscovered: ranked.length,
    });
    const knownKeysStart = Date.now();
    const knownKeys = args.refreshExisting
      ? new Set<string>()
      : await (options?.loadKnownKeys?.() ?? Promise.resolve(new Set()));
    console.log(
      `[FiskeridirJob] knownKeys: ${knownKeys.size} loaded in ${Date.now() - knownKeysStart}ms (refreshExisting=${args.refreshExisting ?? false})`,
    );
    const unseenRanked = ranked.filter(
      (item) => !knownKeys.has(jmeldingFragmentKey(item.url)),
    );
    const skippedExisting = ranked.length - unseenRanked.length;
    console.log(
      `[FiskeridirJob] filtered: ${unseenRanked.length} unseen / ${ranked.length} ranked (skippedExisting=${skippedExisting})`,
    );
    context.reportProgress({
      phase: "filtering-known-fragments",
      message: `Found ${knownKeys.size} existing fragments; ${unseenRanked.length}/${ranked.length} announcements need events`,
      itemsDiscovered: ranked.length,
      knownItems: knownKeys.size,
      skippedExisting,
    });
    const listingFingerprint = createHash("sha256")
      .update(ranked.map((item) => `${item.url}::${item.status}`).join("\n"))
      .digest("hex");
    if (unseenRanked.length === 0) {
      await context.checkpoint?.((state) => {
        state.job.cursor = undefined;
        state.job.listingFingerprint = listingFingerprint;
        state.job.progress = {
          phase: "completed",
          message: `All ${ranked.length} announcements already exist in Usable; no events emitted`,
          percent: 100,
          itemsDiscovered: ranked.length,
          knownItems: knownKeys.size,
          skippedExisting,
          updatedAt: new Date().toISOString(),
        };
      });
      return {
        checkedAt,
        changed: false,
        latestItems: previous?.latestItems ?? [],
        message: `Skipped ${ranked.length} existing J-meldinger; no events emitted`,
      };
    }
    if (
      !args.refreshExisting &&
      previous?.lastRunStatus === "success" &&
      previous.listingFingerprint === listingFingerprint
    ) {
      context.reportProgress({
        phase: "completed",
        message: `Listings unchanged (${ranked.length} items). Skipping detail enrichment.`,
        itemsDiscovered: ranked.length,
      });
      return {
        checkedAt,
        changed: false,
        latestItems: previous.latestItems ?? [],
        message: `Checked ${ranked.length} listings; no changes since last run`,
      };
    }
    const previousLatestItems = previous?.latestItems
      ? [...previous.latestItems]
      : [];
    let startIndex = 0;
    const resumeUrl = previous?.cursor?.lastProcessedUrl;
    if (previous?.lastRunStatus !== "success" && resumeUrl) {
      const resumeIdx = ranked.findIndex((item) => item.url === resumeUrl);
      if (resumeIdx >= 0 && resumeIdx + 1 < ranked.length) {
        startIndex = resumeIdx + 1;
      }
    }
    const toProcess = unseenRanked.slice(startIndex);
    const resumeItems = startIndex > 0 ? previousLatestItems : [];
    console.log(
      `[FiskeridirJob] emit phase: ${toProcess.length} items to process (startIndex=${startIndex}, concurrency=${FETCH_CONCURRENCY})`,
    );
    await context.checkpoint?.((state) => {
      state.job.cursor = {
        mode: "announcement",
        lastProcessedUrl:
          startIndex > 0 ? unseenRanked[startIndex - 1]?.url : undefined,
        processedCount: startIndex,
        totalCount: unseenRanked.length,
        updatedAt: checkedAt,
      };
      state.job.listingFingerprint = listingFingerprint;
    });
    const latestItems: JobLatestItem[] = [];
    const emitPhaseStart = Date.now();
    for (
      let chunkStart = 0;
      chunkStart < toProcess.length;
      chunkStart += FETCH_CONCURRENCY
    ) {
      if (context.signal.aborted || context.isStopRequested()) {
        console.warn(
          `[FiskeridirJob] stop requested at chunkStart=${chunkStart}/${toProcess.length}`,
        );
        throw new Error("Job stopped by request");
      }
      const chunk = toProcess.slice(chunkStart, chunkStart + FETCH_CONCURRENCY);
      const batchStart = Date.now();
      const enriched = await Promise.all(
        chunk.map((item) => fetchDetail(item, context.signal)),
      );
      const fetchMs = Date.now() - batchStart;
      const writeStart = Date.now();
      for (const item of enriched) {
        await writer.writeJMeldingAnnouncement({
          ...item,
          region: "NO",
          bodyMarkdown: item.bodyMarkdown ?? "",
          checkedAt,
        });
        latestItems.push({ ...item, lastCheckedAt: checkedAt });
        const absoluteProcessed = startIndex + latestItems.length;
        await context.checkpoint?.((state) => {
          const checkpointItems = [...resumeItems, ...latestItems].slice(0, 25);
          state.job.cursor = {
            mode: "announcement",
            lastProcessedUrl: item.url,
            processedCount: absoluteProcessed,
            totalCount: unseenRanked.length,
            updatedAt: new Date().toISOString(),
          };
          state.job.latestItems = checkpointItems;
          state.job.progress = {
            phase: "emitting-events",
            message: `Emitted ${absoluteProcessed}/${unseenRanked.length} new announcements (${skippedExisting} skipped existing)`,
            detailsProcessed: absoluteProcessed,
            detailsTotal: unseenRanked.length,
            knownItems: knownKeys.size,
            skippedExisting,
            updatedAt: new Date().toISOString(),
          };
        });
      }
      const writeMs = Date.now() - writeStart;
      const absoluteDone = startIndex + latestItems.length;
      const elapsedSec = Math.max(1, (Date.now() - emitPhaseStart) / 1000);
      const rate = (absoluteDone - startIndex) / elapsedSec;
      const remaining = unseenRanked.length - absoluteDone;
      const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
      console.log(
        `[FiskeridirJob] batch ${Math.floor(chunkStart / FETCH_CONCURRENCY) + 1}: fetched ${chunk.length} in ${fetchMs}ms, wrote in ${writeMs}ms → ${absoluteDone}/${unseenRanked.length} (${rate.toFixed(1)}/s, ETA ${etaSec}s)`,
      );
      context.reportProgress({
        phase: "emitting-events",
        message: `Emitted ${startIndex + latestItems.length}/${unseenRanked.length} new announcements (${skippedExisting} skipped existing)`,
        detailsProcessed: startIndex + latestItems.length,
        detailsTotal: unseenRanked.length,
        knownItems: knownKeys.size,
        skippedExisting,
      });
    }
    console.log(
      `[FiskeridirJob] run complete: ${latestItems.length} announcements emitted in ${Date.now() - jobStart}ms total`,
    );
    await context.checkpoint?.((state) => {
      state.job.cursor = undefined;
      state.job.listingFingerprint = listingFingerprint;
    });
    const previousByUrl = new Map(
      previousLatestItems.map((item) => [item.url, item]),
    );
    const combinedLatestItems = [...resumeItems, ...latestItems].slice(0, 25);
    const changed =
      combinedLatestItems.length !== previousLatestItems.length ||
      combinedLatestItems.some(
        (item) => previousByUrl.get(item.url)?.signature !== item.signature,
      );
    return {
      checkedAt,
      changed,
      latestItems: combinedLatestItems,
      message: changed
        ? `Processed ${latestItems.length} J-meldinger; emitted changes`
        : `Processed ${latestItems.length} J-meldinger; no changes since last check`,
    };
  };
}
