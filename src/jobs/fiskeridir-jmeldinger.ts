import { createHash } from "node:crypto";
import type { Env } from "@/env";
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

function detectStatus(text: string, fallback: JobLatestItem["status"]) {
  const lower = text.toLowerCase();
  if (
    lower.includes("current") ||
    lower.includes("gjeldende") ||
    lower.includes("gjeldande")
  ) {
    return "current";
  }
  if (
    lower.includes("historisk") ||
    lower.includes("utgått") ||
    lower.includes("utgaatt") ||
    lower.includes("avsluttet") ||
    lower.includes("arkiv") ||
    lower.includes("expired")
  ) {
    return "archived";
  }
  return fallback;
}

function extractJMeldingNumber(text: string) {
  const match = text.toLowerCase().match(/\bj-(\d+)-(\d{4})\b/);
  return match ? `j-${match[1]}-${match[2]}` : undefined;
}

function extractValidity(text: string) {
  return {
    validFrom: text.match(
      /(?:gyldig\s+fra)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    )?.[1],
    validTo: text.match(
      /(?:gyldig\s+til)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
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
    const idx = match.index ?? 0;
    const context = stripTags(
      html.slice(Math.max(0, idx - 700), Math.min(html.length, idx + 700)),
    );
    deduped.set(href, {
      title,
      url: href,
      status: detectStatus(`${title} ${context}`, fallbackStatus),
      publishedAt: extractDate(`${title} ${context}`),
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
  const first = await fetch(input.baseUrl, {
    headers: { "user-agent": "FishFactsJobs/1.0", accept: "text/html" },
    signal: input.signal,
  });
  if (!first.ok) throw new Error(`Fiskeridir listing HTTP ${first.status}`);
  const firstHtml = await first.text();
  const maxPage = Math.min(input.maxPages, parseMaxPage(firstHtml));
  for (const item of parseLinks(firstHtml, input.baseUrl, "unknown")) {
    candidates.set(item.url, item);
  }
  input.reportProgress({
    phase: "crawling-listings",
    message: `Crawled 1/${maxPage} pages (${candidates.size} items found)`,
    pagesProcessed: 1,
    pagesTotal: maxPage,
    itemsDiscovered: candidates.size,
  });
  for (let page = 2; page <= maxPage; page += 1) {
    const pageUrl = `${input.baseUrl}${input.baseUrl.includes("?") ? "&" : "?"}page=${page}`;
    const response = await fetch(pageUrl, {
      headers: { "user-agent": "FishFactsJobs/1.0", accept: "text/html" },
      signal: input.signal,
    });
    if (!response.ok) continue;
    for (const item of parseLinks(
      await response.text(),
      input.baseUrl,
      "unknown",
    )) {
      candidates.set(item.url, item);
    }
    input.reportProgress({
      phase: "crawling-listings",
      message: `Crawled ${page}/${maxPage} pages (${candidates.size} items found)`,
      pagesProcessed: page,
      pagesTotal: maxPage,
      itemsDiscovered: candidates.size,
    });
  }
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
    pageStatus = detectStatus(`${bodyText} ${item.title}`, pageStatus);
    publishedAt = publishedAt ?? extractDate(bodyText);
    jmNumber = jmNumber ?? extractJMeldingNumber(`${item.title} ${bodyText}`);
    const validity = extractValidity(`${item.title} ${bodyText}`);
    validFrom = validity.validFrom ?? validFrom;
    validTo = validity.validTo ?? validTo;
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
    const checkedAt = new Date().toISOString();
    const candidates = await collectListing({
      baseUrl: env.FISKERIDIR_JMELDINGER_BASE_URL,
      maxPages: args.maxPages,
      signal: context.signal,
      reportProgress: context.reportProgress,
    });
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
    const knownKeys = args.refreshExisting
      ? new Set<string>()
      : await (options?.loadKnownKeys?.() ?? Promise.resolve(new Set()));
    const unseenRanked = ranked.filter(
      (item) => !knownKeys.has(jmeldingFragmentKey(item.url)),
    );
    const skippedExisting = ranked.length - unseenRanked.length;
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
    for (
      let chunkStart = 0;
      chunkStart < toProcess.length;
      chunkStart += FETCH_CONCURRENCY
    ) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const chunk = toProcess.slice(chunkStart, chunkStart + FETCH_CONCURRENCY);
      const enriched = await Promise.all(
        chunk.map((item) => fetchDetail(item, context.signal)),
      );
      for (const item of enriched) {
        await writer.writeJMeldingAnnouncement({
          ...item,
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
      context.reportProgress({
        phase: "emitting-events",
        message: `Emitted ${startIndex + latestItems.length}/${unseenRanked.length} new announcements (${skippedExisting} skipped existing)`,
        detailsProcessed: startIndex + latestItems.length,
        detailsTotal: unseenRanked.length,
        knownItems: knownKeys.size,
        skippedExisting,
      });
    }
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
