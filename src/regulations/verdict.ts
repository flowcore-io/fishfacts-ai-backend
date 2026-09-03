/**
 * The verdict step — the one genuinely new pipeline stage in the approval
 * queue.
 *
 * A model reads one revision of a regulation case and returns a structured
 * issue list, never prose: what in this text cannot be trusted onto a chart
 * without a human, and why. The taxonomy was sized against the corpus (dry
 * run 2026-09-03, approved by Johann) — see the kind enum in
 * `events/contracts.ts` for what each class earned its place with.
 *
 * The answer is validated against the schema and FAILS CLOSED as a case
 * state: an unparseable answer becomes `status: "failed"` on the record, not
 * an exception and never a salvaged half-verdict. Laws are human-written;
 * per-item uncertainty is the point of the exercise.
 */

import {
  type RegulationVerdictIssue,
  regulationVerdictIssueSchema,
} from "@/events/contracts";
import { stripAnswerFence } from "@/logasavn/reader";
import type { EmbedChatMessage } from "@/usable/embed-chat";
import { z } from "zod";

export const VERDICT_INSTRUCTIONS = `You are auditing one fisheries regulation for an approval queue. Report, in structured form, everything about it that cannot be drawn on a nautical chart or trusted as law without a human decision. Do not repair, resolve, compute or interpret anything — report it.

Return a single JSON object, no other text: {"issues": [{"field": string, "kind": string, "ref": string | null, "confidence": number}]}

"field" is where the issue lives, in the source's own words ("§ 2, stk. 1, nr. 3", "Skjal 1, Talva 2", "expiry").
"ref" is what the issue points at, when it points at something: the cited regulation, the landmark name, the coordinate as printed. Otherwise null.
"confidence" is 0..1, your confidence in THIS issue.

"kind" must be exactly one of:
- "underdetermined_boundary": the boundary is described, not enumerated — bearing lines from named landmarks, distance bands off baselines, longitude limits, a coastline closing the area. The vertices printed do not fully determine the shape.
- "unsupported_notation": coordinates whose digits are readable but whose notation differs from the document's jurisdiction norm (e.g. bare decimal degrees in a Faroese statute).
- "external_reference": an area or rule defined in a DIFFERENT regulation that this one only cites.
- "malformed_coordinate": wrong digit count, impossible minute value, an obviously broken coordinate — a transcription problem in the source itself. Quote it verbatim in "ref".
- "unresolved_landmark": a named place used to define geometry with NO printed coordinates anywhere in the document.
- "ambiguous_wording": the legal text genuinely supports more than one reading. Not for malformed digits.
- "missing_expiry": no expiry, repeal or validity end where one is clearly needed.
- "ok": nothing wrong — use one {"field": "overall", "kind": "ok"} entry when the document raises no issues at all.

One entry per problem. Every coordinate-bearing section you cannot fully vouch for deserves an entry.`;

export function buildVerdictMessages(input: {
  title: string;
  jurisdiction: string;
  text: string;
}): EmbedChatMessage[] {
  return [
    {
      role: "user",
      content: `${VERDICT_INSTRUCTIONS}\n\nRegulation (${input.jurisdiction}): ${input.title}\n\n---\n\n${input.text}`,
    },
  ];
}

const verdictAnswerSchema = z.object({
  issues: z.array(regulationVerdictIssueSchema),
});

export type ParsedVerdict =
  | { status: "ok"; issues: RegulationVerdictIssue[] }
  | { status: "failed"; error: string };

/**
 * Judge one answer. Pure — the job does the calling, this decides what the
 * answer is worth, and everything that is not a schema-valid issue list is a
 * recorded failure.
 */
export function parseVerdictAnswer(answer: string): ParsedVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripAnswerFence(answer));
  } catch {
    return { status: "failed", error: "answer is not JSON" };
  }
  const result = verdictAnswerSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: "failed",
      error: `answer does not match the issue schema: ${result.error.issues[0]?.message ?? "unknown"}`,
    };
  }
  return { status: "ok", issues: result.data.issues };
}

/**
 * The record-level confidence (§4 Provenance): the MINIMUM issue confidence,
 * because a verdict is only as trustworthy as its shakiest claim. Null when
 * there are no issues to be confident about.
 */
export function verdictConfidenceOf(
  issues: RegulationVerdictIssue[],
): number | null {
  if (issues.length === 0) return null;
  return Math.min(...issues.map((issue) => issue.confidence));
}
