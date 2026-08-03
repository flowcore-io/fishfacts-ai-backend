/**
 * The sweep's output, written as ONE fragment for a reader rather than as rows
 * for a program.
 *
 * There is no `logasavn_review` table any more, and this is deliberately not a
 * replacement for it: nothing here is approved, nothing here is drawn, and the
 * only consumer is whoever is reading Faroese fisheries law — the skill
 * (`63652773`), or a person. Keeping it as a fragment in the workspace the bot
 * already searches means no schema, no migration and no endpoint stands between
 * the sweep and the reader.
 *
 * Pure and network-free. The job does the fetching and the upsert; this decides
 * what the page says.
 */

import type { IndexEntry, SweepResult } from "./sweep";
import { IN_FORCE } from "./sweep";

/** Stable across runs — the job upserts on it, and the skill points at it. */
export const INDEX_FRAGMENT_KEY = "logasavn-coordinate-index";

export const INDEX_FRAGMENT_TITLE =
  "Lógasavn coordinate index — statutes that mention coordinates";

/**
 * Enough of the hash to see one MOVE, and no more.
 *
 * The full sha256 of every statute body would be two thirds of this fragment by
 * volume, spent on a value nobody reads for its own sake. What it is for is
 * diffing two versions of this page: a row whose text changed since the last
 * sweep is a statute that was re-scraped, and twelve hex characters say that
 * just as clearly as sixty-four.
 */
const HASH_PREFIX_LENGTH = 12;

/** Pipes would split the cell; newlines would split the row. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function row(entry: IndexEntry): string {
  const link = entry.url ? `[source](${entry.url})` : "—";
  const flag = entry.detectorsDisagree ? " ⚠️" : "";
  return [
    "",
    entry.fragmentId,
    cell(entry.title),
    entry.coordinateSignals,
    entry.ringCount,
    entry.vertexCount,
    entry.withheldCount + (entry.withheldCount > 0 ? " ⚠️" : ""),
    entry.contentHash.slice(0, HASH_PREFIX_LENGTH) + flag,
    link,
    "",
  ].join(" | ");
}

const HEADER = [
  "| fragment id | statute | coord. signals | rings read | vertices | withheld | text | source |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

/**
 * In-force first, then by how much geometry is in question.
 *
 * The in-force set is the ~47 that decide what the map shows today. A
 * superseded statute still has to be listed — they come back, and an index that
 * cannot show you one cannot tell you it did — it just is not what a reader
 * meets first.
 */
function ranked(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.vertexCount - a.vertexCount ||
      b.coordinateSignals - a.coordinateSignals ||
      a.title.localeCompare(b.title),
  );
}

function table(entries: IndexEntry[]): string {
  if (entries.length === 0) return "_none_";
  return [HEADER, ...ranked(entries).map(row)].join("\n");
}

/**
 * Build the whole page.
 *
 * `scannedAt` is passed in rather than read from the clock so the content is a
 * function of its inputs and the test can assert the exact text.
 */
export function buildIndexFragment(
  result: SweepResult,
  scannedAt: string,
): {
  key: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
} {
  const { counts, entries } = result;
  const day = scannedAt.slice(0, 10);
  const inForce = entries.filter((entry) => entry.validityStatus === IN_FORCE);
  const superseded = entries.filter(
    (entry) => entry.validityStatus !== IN_FORCE,
  );

  const scope = `${counts.candidates} of ${counts.scanned} Lógasavn fragments mention coordinates (${counts.inForceCandidates} of them in force)`;
  const summary = `${scope}, as scanned on ${day}. A floor for searching, not a complete list of Faroese closures.`;

  const content = `---
key: ${INDEX_FRAGMENT_KEY}
scanned_at: ${scannedAt}
scanned_fragments: ${counts.scanned}
candidates: ${counts.candidates}
in_force_candidates: ${counts.inForceCandidates}
---

# ${INDEX_FRAGMENT_TITLE}

Every fragment in the Lógasavn corpus was read on **${day}** and asked one
question: does its text contain anything that looks like a coordinate?
${counts.candidates} of ${counts.scanned} did. They are listed below.

## This list is a FLOOR, not a ceiling

It was true on ${day} and it decays from then on. The corpus grows and is
re-scraped in place — it held 3,866 fragments in one earlier count and
${counts.scanned} at this one, and \`K 35/2026\` was published in May 2026, long
after the first list of Faroese closures was written by hand.

So:

- **Start here.** It scopes ${counts.scanned} fragments down to
  ${counts.candidates}, and the shortlist is cheap to read properly.
- **Do not stop here.** If the question touches anything after ${day}, or the
  answer you are assembling looks thin, search the corpus directly as well. A
  cold search with no index at all has been shown to find every statute that
  matters; a complete-*looking* list that quietly predates the statute someone
  is asking about has not.
- **Nothing here is verified.** Being on this list means "contains coordinate-shaped
  text", not "is a closure", not "is in force", not "may be drawn".

## What the numbers mean, and what they are worth

\`rings read\`, \`vertices\` and \`withheld\` come from a regex parser, and it is
recorded here as a **witness, never an author**. On \`K 35/2026\` it matched a
careful human reading on all ten vertices to twelve decimal places. On
\`K 113/2014\` it read thirteen tables of *existing fishing grounds* — water where
fishing is permitted — as though they were closures, and every single ring it
produced was valid. Nothing about the output said which was which; only the
Faroese prose above the tables did.

Which is exactly why the counts are published. **If your reading of a statute
disagrees with its numbers here, that disagreement is a finding** — say so, and
say which reading you trust and why. Two independent readings that agree are
worth far more than either alone; two that differ have located the problem.

\`coord. signals\` is a deliberately over-triggering count of coordinate-shaped
text, including the plain decimal-degree tables the parser cannot read at all
(they show \`0\` rings and are not thereby empty). \`withheld ⚠️\` means the parser
extracted something it would not vouch for. \`text\` is the first
${HASH_PREFIX_LENGTH} hex characters of the sha256 of the statute body: if it
changed since the previous version of this page, the statute was re-scraped.

## In force (\`Galdandi\`) — ${inForce.length}

${table(inForce)}

## Superseded or unknown validity — ${superseded.length}

Listed because a superseded statute is still evidence — of what the current one
replaced, and of what comes back if it is repealed. Do not read anything here as
current law.

${table(superseded)}

---

Written by the \`logasavn-sweep\` job in \`fishfacts-ai-backend\`. Re-run it to
refresh this page; it rewrites the fragment in place, so the version history
above is the record of how the corpus moved.
`;

  return {
    key: INDEX_FRAGMENT_KEY,
    title: INDEX_FRAGMENT_TITLE,
    summary,
    content,
    tags: [
      "logasavn",
      "faroe",
      "closures",
      "coordinate-index",
      "repo:fishfacts-ai-backend",
      `scanned:${day}`,
    ],
  };
}
