/**
 * The published-corpus export (stage ③): one Usable fragment per PUBLISHED
 * regulation case, carrying the revision an admin approved — the retrieval
 * half of the 1st mate's two consumption channels (the other is the
 * non-admin read API, which serves the geometry).
 *
 * The boundary mechanics mirror the raw corpus (`raw-fragment.ts`):
 * COLLECTION membership is the guard, scoped on the embed config at
 * retrieval time; tags ride along for humans. The sense is opposite —
 * everything here has been confirmed by a human, so this is the one
 * regulation collection user-facing answers may retrieve from. Un-publish
 * therefore has to REMOVE the fragment from the collection, not merely
 * relabel it: `buildWithdrawnCaseFragment` keeps the key occupied (history
 * plus a stable target should the case be re-approved) while its empty
 * `collectionIds` takes it out of retrieval's reach.
 *
 * Pure builders + staleness decisions; the sync job keeps only the wiring.
 */

import type { PublishedRegulation } from "./published-repository";

/** `fiskeridir-jmelding:J-39-2026` → `regulation-published-fiskeridir-jmelding-J-39-2026`. */
export function publishedFragmentKeyFor(caseKey: string): string {
  return `regulation-published-${caseKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function windowLine(item: PublishedRegulation): string {
  if (!item.effectiveFrom && !item.effectiveTo && !item.expiresAt) {
    return "not stated";
  }
  const end = item.effectiveTo ?? item.expiresAt;
  return `${item.effectiveFrom?.toISOString() ?? "…"} → ${end?.toISOString() ?? "…"}`;
}

/**
 * A frontmatter string value, JSON-quoted. The block is hand-written and read
 * back with `Bun.YAML.parse`, and the admin names are free text: raw, a name
 * like `Foreign-flag: 2026 #1` nulls the whole block and `2026` / `yes` comes
 * back retyped — either way the staleness check never matches again and the
 * fragment is rewritten on every sync. A JSON string is a valid YAML scalar
 * that always reads back as the same string.
 */
function yamlString(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

/**
 * The admins' names, directly under the official heading so they land in the
 * first embedded chunk — what a search by either name matches. Additions to
 * the statute title, never replacements: the title, key and heading stay the
 * official title every citation names. The group line is always there (every
 * published regulation has one, the country default at worst); the short name
 * only when an admin gave one.
 */
function namingLines(item: PublishedRegulation): string {
  const group = `Group: ${item.group.name}`;
  return item.displayName
    ? `Short name (set by FishFacts admins): ${item.displayName}\n${group}`
    : group;
}

export function buildPublishedCaseFragment(
  item: PublishedRegulation,
  now: Date = new Date(),
): {
  key: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
} {
  // `inForce` is computed at WRITE time and nothing revisits an unchanged
  // fragment when the window later lapses (staleness keys on revision +
  // publish stamp only) — so the claim carries its as-of date and defers to
  // the window, instead of an absolute "current" that can quietly go wrong.
  const inForceLine = `In force as of ${now.toISOString().slice(0, 10)}: ${item.inForce} (see validity)`;
  const geometrySections = item.geometries.map((geometry) => {
    const heading = `### ${geometry.name ?? `Area ${geometry.position + 1}`} (${geometry.kind}${geometry.season ? `, ${geometry.season}` : ""})`;
    const points = geometry.points
      .map((point) => `  - ${point.lat}, ${point.lon}`)
      .join("\n");
    return `${heading}\n\n${points || "  (no vertices)"}`;
  });

  const content = `---
caseKey: ${item.caseKey}
revisionId: ${item.publishedRevisionId}
publishedAt: ${item.publishedAt?.toISOString() ?? "null"}
state: published
displayName: ${yamlString(item.displayName)}
groupId: ${yamlString(item.group.id)}
groupName: ${yamlString(item.group.name)}
groupIsDefault: ${item.group.isDefault}
---

# ${item.title}

${namingLines(item)}

Reviewed and approved regulation — safe to cite in user-facing answers.

- Jurisdiction: ${item.jurisdiction}${item.authority ? ` · Authority: ${item.authority}` : ""}${item.regulationNumber ? ` · Number: ${item.regulationNumber}` : ""}
- Source: ${item.sourceType} — ${item.sourceUrl}
- Validity: ${windowLine(item)} · ${inForceLine}${item.seasonalRecurrence ? `\n- Seasonal recurrence: ${item.seasonalRecurrence}` : ""}${item.category ? `\n- Category: ${item.category}` : ""}${item.summary ? `\n- Summary: ${item.summary}` : ""}${item.interpretationNotes ? `\n- Interpretation notes: ${item.interpretationNotes}` : ""}

## Areas

${geometrySections.join("\n\n") || (item.metadataOnly ? "Metadata-only regulation — it defines no drawable area." : "No areas on the approved revision.")}

*Exact geometry for drawing: \`GET /api/regulations/published/${item.id}\`.*
`;

  return {
    key: publishedFragmentKeyFor(item.caseKey),
    title: item.title,
    summary: `Approved regulation ${item.caseKey} (${item.jurisdiction}), ${item.inForce} as of ${now.toISOString().slice(0, 10)}.`,
    content,
    tags: [
      "regulation",
      "regulation-case",
      "published",
      `jurisdiction:${item.jurisdiction}`,
      `source:${item.sourceType}`,
      // The id, never the name: a name with spaces or ð fails Usable's tag
      // pattern and would fail the whole write.
      `group:${item.group.id}`,
    ],
  };
}

/** The tombstone an un-published case leaves behind. Its `collectionIds`
 * must be set to [] on write — leaving the collection IS the un-publish. */
export function buildWithdrawnCaseFragment(withdrawn: {
  caseKey: string;
  title: string;
}): {
  key: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
} {
  return {
    key: publishedFragmentKeyFor(withdrawn.caseKey),
    title: `[WITHDRAWN] ${withdrawn.title}`,
    summary: `Regulation case ${withdrawn.caseKey} was un-published — no longer a user-facing record.`,
    content: `---
caseKey: ${withdrawn.caseKey}
revisionId: null
publishedAt: null
state: withdrawn
---

# ${withdrawn.title}

This regulation was withdrawn from the published corpus (declined in the
admin review queue after having been published). Do not cite it.
`,
    tags: ["regulation", "regulation-case", "withdrawn"],
  };
}

/** Is the fragment already faithful to the published case? Decided from the
 * frontmatter the last sync wrote — the pinned revision id and the publish
 * stamp cover every revision field the fragment renders except the computed
 * `inForce`, which is why an `inForce` flip alone does not force a rewrite:
 * the validity window it derives from is unchanged and in the content.
 *
 * The group is NOT a revision field: an admin rename or retire changes the
 * name (or the group itself) with no new revision, so the group id and name
 * are compared on their own. The display name rides on the revision already;
 * it is compared too so a fragment written before names existed reads stale.
 * A fragment missing any of these keys is stale — which is how the corpus
 * written before this change is rewritten exactly once. */
export function publishedFragmentIsCurrent(
  frontmatter: Record<string, unknown> | null,
  item: PublishedRegulation,
): boolean {
  if (!frontmatter) return false;
  return (
    frontmatter.state === "published" &&
    frontmatter.revisionId === item.publishedRevisionId &&
    String(frontmatter.publishedAt ?? "null") ===
      (item.publishedAt?.toISOString() ?? "null") &&
    optionalString(frontmatter.displayName) === item.displayName &&
    optionalString(frontmatter.groupId) === item.group.id &&
    optionalString(frontmatter.groupName) === item.group.name
  );
}

/** A frontmatter value as the string it was written as — `null` and a
 * missing key both read as null, so a display name literally called "null"
 * still differs from no display name. */
function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function withdrawnFragmentIsCurrent(
  frontmatter: Record<string, unknown> | null,
): boolean {
  return frontmatter?.state === "withdrawn";
}
