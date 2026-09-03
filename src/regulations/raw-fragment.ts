/**
 * The raw-corpus export: one Usable fragment per regulation case, carrying
 * PARSER OUTPUT — never the fetched page text, which stays canonical in
 * PostgreSQL (decision 6).
 *
 * "Raw" is a retrieval boundary, not a quality label: no human has read these,
 * so they may only ever be reachable from the admin config. The boundary is
 * drawn by COLLECTION membership (metadata — redrawable later without
 * re-ingesting) and scoped on the embed config at retrieval time. The `raw`
 * tag rides along for human filtering only; a tag must never be the guard,
 * because a tag filter that silently drops out of a query looks applied and
 * is not.
 *
 * Pure builders + a staleness decision, so the sync job keeps only the wiring.
 */

import type { RegulationVerdictIssue } from "@/events/contracts";

export type RawSyncCase = {
  caseKey: string;
  title: string;
  jurisdiction: string;
  sourceType: string;
  sourceRef: string;
  sourceUrl: string;
  category: string | null;
  summary: string | null;
  sourceStatus: string;
  changeType: string;
  regulationStatus: string;
  adminStatus: string;
  verdictStatus: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  currentRevisionId: string;
  verdict: unknown;
  verdictRecordedAt: Date | null;
};

export type RawSyncGeometry = {
  position: number;
  name: string | null;
  kind: string;
  season: string | null;
  points: Array<{ lat: number; lon: number }>;
  geometrySource: string;
};

/** `fiskeridir-jmelding:J-39-2026` → `regulation-raw-fiskeridir-jmelding-J-39-2026`. */
export function rawFragmentKeyFor(caseKey: string): string {
  return `regulation-raw-${caseKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function issueLines(verdict: unknown): string[] {
  if (!Array.isArray(verdict) || verdict.length === 0) return [];
  return (verdict as RegulationVerdictIssue[]).map(
    (issue) =>
      `- \`${issue.kind}\` at ${issue.field} (confidence ${issue.confidence})${issue.ref ? ` → ${issue.ref}` : ""}`,
  );
}

export function buildRawCaseFragment(
  item: RawSyncCase,
  geometries: RawSyncGeometry[],
): {
  key: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
} {
  const window =
    item.effectiveFrom || item.effectiveTo
      ? `${item.effectiveFrom?.toISOString() ?? "…"} → ${item.effectiveTo?.toISOString() ?? "…"}`
      : "not stated";

  const geometrySections = geometries.map((geometry) => {
    const heading = `### ${geometry.name ?? `Area ${geometry.position + 1}`} (${geometry.kind}${geometry.season ? `, ${geometry.season}` : ""})`;
    const points = geometry.points
      .map((point) => `  - ${point.lat}, ${point.lon}`)
      .join("\n");
    return `${heading}\n\nSource: ${geometry.geometrySource}\n\n${points || "  (no vertices)"}`;
  });

  const issues = issueLines(item.verdict);

  const content = `---
caseKey: ${item.caseKey}
revisionId: ${item.currentRevisionId}
verdictRecordedAt: ${item.verdictRecordedAt?.toISOString() ?? "null"}
state: raw
---

# ${item.title}

**RAW parser output — no human has confirmed this. Admin use only; never a user-facing answer.**

- Jurisdiction: ${item.jurisdiction} · Source: ${item.sourceType} (\`${item.sourceRef}\`)
- Source URL: ${item.sourceUrl}
- Source validity claim: ${item.sourceStatus} · Effective: ${window}
- Change type: ${item.changeType} · Regulation status: ${item.regulationStatus} · Admin status: ${item.adminStatus}
- Verdict: ${item.verdictStatus}${item.category ? `\n- Category: ${item.category}` : ""}${item.summary ? `\n- Reading: ${item.summary}` : ""}

## Geometries (current revision)

${geometrySections.join("\n\n") || "No geometry parsed — metadata-only case."}

## Verdict issues

${issues.join("\n") || "None recorded."}
`;

  return {
    key: rawFragmentKeyFor(item.caseKey),
    title: `[RAW] ${item.title}`,
    summary: `Raw parser output for regulation case ${item.caseKey} — unreviewed, admin only.`,
    content,
    tags: [
      "raw",
      "regulation",
      "regulation-case",
      `jurisdiction:${item.jurisdiction}`,
      `source:${item.sourceType}`,
    ],
  };
}

/**
 * Is the fragment already faithful to the case? Decided from the frontmatter
 * the last sync wrote — the revision id and the verdict stamp cover every
 * field the fragment renders, and comparing them beats diffing markdown.
 */
export function rawFragmentIsCurrent(
  frontmatter: Record<string, unknown> | null,
  item: RawSyncCase,
): boolean {
  if (!frontmatter) return false;
  return (
    frontmatter.revisionId === item.currentRevisionId &&
    String(frontmatter.verdictRecordedAt ?? "null") ===
      (item.verdictRecordedAt?.toISOString() ?? "null")
  );
}
