/**
 * The decision behind `scripts/jmelding-sync-fragments.ts`, kept here rather
 * than in the script so it is typechecked and testable: given a corrected
 * `jmelding_geo` row and the fragment as it stands, decide whether the fragment
 * needs rebuilding and, if so, what record to rebuild it from. The script keeps
 * only the wiring — `loadEnv`, the query, the loop.
 *
 * Two things are easy to get wrong here and both are load-bearing:
 *
 * 1. **The two sides of the comparison are not in the same units.** The
 *    fragment's `valid_from` is whatever the source wrote — Fiskeridir's raw
 *    `"07.07.2023"`, Vørn's prose — because the scraper stores the candidate
 *    string, not the parsed value. The column is the instant the geo projector
 *    derived from that same string via `parseValidityStart` /
 *    `parseValidityEnd`. Comparing them literally marks every correctly-scraped
 *    fragment as out of sync, which turns the run into the mass re-embed the
 *    diff-check exists to prevent. So both sides go through the same parse.
 * 2. **The announcement body only exists in the fragment.** `jmelding_geo`
 *    keeps no body, so a rebuild from a fragment whose body could not be
 *    recovered replaces the announcement with `buildMarkdown`'s "No body
 *    content extracted from source page." placeholder — unrecoverable short of
 *    a re-scrape. Such rows are refused, not rebuilt.
 *
 * The rebuilt fragment carries the **instant**, not the source string: the
 * database row is what this script copies, and the normalisation above means a
 * later re-scrape writing the raw string back still compares equal, so the
 * corpus holding both formats causes no churn.
 */
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import { announcementBodyFromContent } from "@/jobs/jmelding-fragments";
import { frontmatterFromContent } from "@/usable/client";
import { parseValidityEnd, parseValidityStart } from "./validity";

/** The `jmelding_geo` columns this sync reads. */
export type JMeldingGeoSyncRow = {
  jm_number: string;
  fragment_key: string;
  title: string;
  status: JMeldingAnnouncementDiscovered["status"];
  region: "NO" | "FO" | "IS";
  category: string | null;
  url: string;
  signature: string;
  valid_from: Date | null;
  valid_to: Date | null;
};

/** The window and status a fragment currently claims, verbatim, for reporting. */
export type FragmentClaims = {
  status?: string;
  validFrom?: string;
  validTo?: string;
};

export type FragmentSyncDecision =
  /** Fragment already agrees with the read model — leave it alone. */
  | { action: "in-sync" }
  /**
   * Rebuilding would destroy something the database cannot give back, so the
   * row is skipped and reported instead.
   */
  | { action: "unrecoverable"; reason: string }
  | {
      action: "rewrite";
      announcement: JMeldingAnnouncementDiscovered;
      claims: FragmentClaims;
    };

export const isoInstant = (value: Date | null | undefined) =>
  value?.toISOString();

function frontmatterText(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A fragment's stored validity date as an instant, so it compares like-for-like
 * against the column the geo projector derived from the same source text. Text
 * that will not parse (Vørn's `valid_from: "í dag, hin 22"`) is kept as-is: it
 * can never equal an instant, so those fragments still get rebuilt and cleaned.
 */
export function fragmentValidityInstant(
  raw: unknown,
  parse: (value?: string | null) => string | undefined,
): string | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  return parse(text) ?? text;
}

/** True when the fragment's status or validity window has drifted from the row. */
export function fragmentDiffers(
  frontmatter: Record<string, unknown>,
  row: JMeldingGeoSyncRow,
): boolean {
  return (
    frontmatterText(frontmatter, "status") !== row.status ||
    fragmentValidityInstant(frontmatter.valid_from, parseValidityStart) !==
      isoInstant(row.valid_from) ||
    fragmentValidityInstant(frontmatter.valid_to, parseValidityEnd) !==
      isoInstant(row.valid_to)
  );
}

/**
 * The row, back in the shape the fragment projector consumes: authoritative
 * fields from the database, everything the database does not keep (body,
 * published date, content hash, and when the source was last actually seen)
 * carried across from the fragment as it stands. `last_checked_at` is preserved
 * for the same reason as its neighbours — this run fetched nothing from the
 * source, so it is in no position to claim a fresh check.
 */
export function announcementFromRow(
  row: JMeldingGeoSyncRow,
  frontmatter: Record<string, unknown>,
  body: string,
  now: Date = new Date(),
): JMeldingAnnouncementDiscovered {
  return {
    signature: row.signature,
    title: row.title,
    url: row.url,
    status: row.status,
    region: row.region,
    jmNumber: row.jm_number,
    category: row.category ?? undefined,
    validFrom: isoInstant(row.valid_from),
    validTo: isoInstant(row.valid_to),
    publishedAt: frontmatterText(frontmatter, "published_at"),
    createdAt: frontmatterText(frontmatter, "announcement_created_at"),
    contentHash: frontmatterText(frontmatter, "content_hash"),
    bodyMarkdown: body,
    checkedAt:
      frontmatterText(frontmatter, "last_checked_at") ?? now.toISOString(),
  };
}

/**
 * The whole per-row decision surface: what to do with this fragment's content
 * given what the read model now says.
 */
export function decideFragmentSync(
  row: JMeldingGeoSyncRow,
  content: string | undefined,
  now: Date = new Date(),
): FragmentSyncDecision {
  // A fragment with no content can neither be compared nor rebuilt from.
  if (!content?.trim()) {
    return { action: "unrecoverable", reason: "fragment has no content" };
  }

  const frontmatter = frontmatterFromContent(content) ?? {};
  if (!fragmentDiffers(frontmatter, row)) return { action: "in-sync" };

  const body = announcementBodyFromContent(content);
  if (!body) {
    return {
      action: "unrecoverable",
      reason: "no recoverable announcement body — needs a re-scrape",
    };
  }

  return {
    action: "rewrite",
    announcement: announcementFromRow(row, frontmatter, body, now),
    claims: {
      status: frontmatterText(frontmatter, "status"),
      validFrom: frontmatterText(frontmatter, "valid_from"),
      validTo: frontmatterText(frontmatter, "valid_to"),
    },
  };
}

/**
 * `--limit N`. Unvalidated, `Number("--apply")` is `NaN` and `synced >= NaN` is
 * always false, so a typo on the cautious run silently means "no limit" — the
 * difference between 20 writes and ~6 800 against production.
 */
export function parseLimitFlag(raw: string | undefined): number {
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--limit must be a positive integer (got "${raw}")`);
  }
  return value;
}
