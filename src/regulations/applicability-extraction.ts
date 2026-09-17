/**
 * The applicability extraction — reading who a regulation applies to out of
 * its own text, for an admin to confirm.
 *
 * Everything here is pure: the prompt, and the judgement of one answer. The
 * job does the calling (`src/jobs/regulation-applicability.ts`); this module
 * decides what the answer is worth.
 *
 * The rule the whole feature rests on: NOTHING IS PROPOSED THAT THE SOURCE
 * DOES NOT SAY. A J-melding that closes an area for "torsketrål" must not
 * come back as "trål" — the broadening is invisible to an admin skimming a
 * list and would put the wrong vessels inside a closure. Two checks, both
 * exact substring containment against the source text (no case folding, no
 * accent normalisation, no whitespace collapsing — everything that would let
 * a paraphrase through is precisely what is being caught):
 *
 * 1. every stated dimension arrives with a quote that is IN the text;
 * 2. every VALUE of an atomic dimension (species, gear, vesselType,
 *    vesselFlag, fishery, permits, and the printed bounds of vesselLength /
 *    vesselPower) is itself in the text, AS A WHOLE WORD. An honest quote
 *    does not license a broadened value: `gear: ["trål"]` quoted with "fiske
 *    med torsketrål" passes check 1, and would pass a plain substring test —
 *    "trål" sits inside "torsketrål" — so the value check refuses a match
 *    that continues into a letter or a digit on either side. That is the
 *    Røstbanken case, and the reason the check is not `String.includes`.
 *
 * `exemptions` are deliberately NOT value-checked: a whole condition is
 * assembled across lines and line breaks ("fartøy under 15 meter som fisker
 * med garn"), so contiguity in the source is the wrong bar. They are
 * backstopped by their quote and by the admin's review. `activity` is an
 * enum with no source form to compare against.
 *
 * A model that fails either check has stopped copying, and the whole case is
 * refused rather than half of it kept (a partial proposal is the shape an
 * admin trusts least — it looks complete).
 *
 * The spike behind the prompt (11 real FO/IS/NO cases, 30/30 quotes verbatim)
 * is recorded in Usable decision `438dcef1-f0b8-481d-b31c-efd65454dae2`.
 */

import { stripAnswerFence } from "@/logasavn/reader";
import type { EmbedChatMessage } from "@/usable/embed-chat";
import {
  APPLICABILITY_DIMENSIONS,
  type ApplicabilityDimension,
  type RegulationApplicability,
  type RegulationApplicabilityEvidence,
  regulationApplicabilitySchema,
} from "./applicability";

export const APPLICABILITY_INSTRUCTIONS = `You are reading one fisheries regulation and recording WHO IT APPLIES TO, for a human reviewer who will confirm or correct you. You are not summarising the regulation and not interpreting it.

Return a single JSON object, no other text. Every key is optional:

{
  "species": string[],        // species named by the text
  "gear": string[],           // gear named by the text
  "vesselType": string[],     // vessel classes named by the text
  "vesselLength": {"min": string, "max": string},   // bounds AS PRINTED, e.g. {"max": "15 m"}
  "vesselPower": {"min": string, "max": string},    // bounds AS PRINTED, e.g. {"max": "120 BT"}
  "vesselFlag": string[],     // flag states / nationalities named by the text
  "fishery": string[],        // named fisheries the rule is about
  "permits": string[],        // licences or permits the rule requires or names
  "exemptions": string[],     // whole conditions under which the rule does NOT apply
  "activity": "prohibited" | "allowed",             // is the activity forbidden or permitted inside the areas
  "evidence": {"<key>": string},                    // ONE VERBATIM QUOTE per key you state above
  "notes": string             // a message to the human reviewer
}

Rules, in order of importance:
1. OMIT any key the text does not state. An omitted key means "this regulation puts no restriction on that dimension" — which is a real and common answer. Never guess, never infer from the title, never fill a key from general knowledge of the fishery.
2. Copy values in the SOURCE'S OWN LANGUAGE, exactly as printed. Do not translate, do not normalise, do not generalise: if the text says "torsketrål", the value is "torsketrål" — never "trål" and never "trawl".
3. Use the EXACT TOKEN the text uses, whole. When the term only ever appears inside a longer compound word, the value is that whole compound as printed: if the text only says "reketrålfiske", the value is "reketrålfiske", not "reketrål" — and quote it the same way. A value cut out of the middle of a word is discarded.
4. Every key you state MUST have an entry in "evidence" holding a quote COPIED CHARACTER-FOR-CHARACTER out of the text above, long enough to contain the value. An answer whose quote cannot be found in the text verbatim is discarded in full.
5. Put whole conditions into "exemptions" as they read ("fartøy under 15 meter som fisker med garn"), rather than splitting one condition across several keys where it becomes a different rule.
6. Use "notes" to tell the reviewer what you could not determine and why, or which other regulation they have to consult. If the text states no applicability at all, return {"notes": "..."} and nothing else.`;

export function buildApplicabilityMessages(input: {
  title: string;
  jurisdiction: string;
  text: string;
}): EmbedChatMessage[] {
  return [
    {
      role: "user",
      content: `${APPLICABILITY_INSTRUCTIONS}\n\nRegulation (${input.jurisdiction}): ${input.title}\n\n---\n\n${input.text}`,
    },
  ];
}

/** Why an extraction produced no proposal. The job adds the reasons that are
 * about fetching rather than reading (`no_source_text`, `chat_error`,
 * `stale_base`) — these three are about the answer itself. */
export type ApplicabilityFailureReason =
  | "unparseable"
  | "quote_not_in_source"
  | "value_not_in_source";

/** The dimensions whose values are atomic enough to demand verbatim in the
 * source: a species, a gear, a vessel class, a flag, a fishery, a permit are
 * all named by the text in one piece. `exemptions` (assembled conditions) and
 * `activity` (an enum) are not in here — see the module header. */
const VALUE_CHECKED_LIST_DIMENSIONS = [
  "species",
  "gear",
  "vesselType",
  "vesselFlag",
  "fishery",
  "permits",
] as const;

/** Printed bounds — `{ max: "15 m" }` — checked the same way, per side. */
const VALUE_CHECKED_BOUND_DIMENSIONS = ["vesselLength", "vesselPower"] as const;

export type ApplicabilityExtraction =
  | { kind: "proposal"; applicability: RegulationApplicability }
  | {
      kind: "failed";
      reason: ApplicabilityFailureReason;
      detail: string;
    };

/** The dimensions this answer actually states — everything that therefore
 * needs a verbatim quote behind it. */
export function statedDimensionsOf(
  applicability: RegulationApplicability,
): ApplicabilityDimension[] {
  return APPLICABILITY_DIMENSIONS.filter(
    (dimension) => applicability[dimension] !== undefined,
  );
}

/**
 * Judge one answer against the text it claims to have read.
 *
 * `sourceText` is the same string that went into the prompt — the check is
 * exact substring containment, so anything that would make a paraphrase pass
 * (lowercasing, stripping accents, collapsing whitespace) is deliberately
 * absent.
 */
export function parseApplicabilityAnswer(
  answer: string,
  sourceText: string,
): ApplicabilityExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripAnswerFence(answer));
  } catch {
    return {
      kind: "failed",
      reason: "unparseable",
      detail: "answer is not JSON",
    };
  }
  const result = regulationApplicabilitySchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      kind: "failed",
      reason: "unparseable",
      detail: `answer does not match the applicability schema: ${
        issue
          ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
          : "unknown"
      }`,
    };
  }

  const applicability = normalizeEmptyDimensions(result.data);
  const stated = statedDimensionsOf(applicability);
  const unquoted: string[] = [];
  for (const dimension of stated) {
    const quote = applicability.evidence?.[dimension];
    if (quote === undefined) {
      unquoted.push(`${dimension}: no quote given`);
    } else if (!sourceText.includes(quote)) {
      unquoted.push(`${dimension}: quote is not verbatim in the source text`);
    }
  }
  if (unquoted.length > 0) {
    return {
      kind: "failed",
      reason: "quote_not_in_source",
      detail: unquoted.join("; "),
    };
  }

  const invented: string[] = [];
  for (const dimension of VALUE_CHECKED_LIST_DIMENSIONS) {
    for (const value of applicability[dimension] ?? []) {
      if (!containsAsWholeWord(sourceText, value)) {
        invented.push(`${dimension}: "${value}" is not in the source text`);
      }
    }
  }
  for (const dimension of VALUE_CHECKED_BOUND_DIMENSIONS) {
    const bound = applicability[dimension];
    if (bound === undefined) continue;
    for (const side of ["min", "max"] as const) {
      const value = bound[side];
      if (value !== undefined && !containsAsWholeWord(sourceText, value)) {
        invented.push(
          `${dimension}.${side}: "${value}" is not in the source text`,
        );
      }
    }
  }
  if (invented.length > 0) {
    return {
      kind: "failed",
      reason: "value_not_in_source",
      detail: invented.join("; "),
    };
  }

  // A quote for a dimension the answer does not state would render next to a
  // "no restriction stated" row and read as evidence FOR a restriction. It
  // costs nothing to drop and there is nothing for the admin to confirm.
  const evidence = applicability.evidence;
  if (evidence !== undefined) {
    const kept: RegulationApplicabilityEvidence = {};
    for (const dimension of stated) {
      const quote = evidence[dimension];
      if (quote !== undefined) kept[dimension] = quote;
    }
    // `undefined` rather than a delete: it serialises away with the event
    // payload and reads back as the absent key it is.
    applicability.evidence = stated.length === 0 ? undefined : kept;
  }

  return { kind: "proposal", applicability };
}

/**
 * An empty list or an empty pair of bounds is not a statement — it is the
 * model writing down that it found nothing, which is exactly what an OMITTED
 * key means. Normalising them away (and dropping the quote that came with
 * them) keeps one representation of "no restriction stated" instead of two
 * that render differently, and spares an empty list a quote it cannot have.
 */
function normalizeEmptyDimensions(
  applicability: RegulationApplicability,
): RegulationApplicability {
  const normalized = { ...applicability };
  const evidence = { ...normalized.evidence };
  let stripped = false;
  for (const dimension of APPLICABILITY_DIMENSIONS) {
    const value = normalized[dimension];
    const isEmpty =
      (Array.isArray(value) && value.length === 0) ||
      (dimension === "vesselLength" || dimension === "vesselPower"
        ? value !== undefined &&
          (value as { min?: string; max?: string }).min === undefined &&
          (value as { min?: string; max?: string }).max === undefined
        : false);
    if (!isEmpty) continue;
    normalized[dimension] = undefined;
    evidence[dimension] = undefined;
    stripped = true;
  }
  if (stripped && normalized.evidence !== undefined) {
    normalized.evidence = evidence;
  }
  return normalized;
}

/**
 * Exact containment, but refusing a match that continues into a letter or a
 * digit — `"trål"` is not found in `"torsketrål"`, and `"15 m"` is not found
 * in `"15 meter"`. Still exact in every other respect: no case folding, no
 * accent normalisation, no whitespace collapsing.
 *
 * The boundary is only demanded on a side where the VALUE itself ends in a
 * letter or digit; a value that starts or ends in punctuation ("§ 2,") is
 * compared as printed.
 */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function containsAsWholeWord(source: string, value: string): boolean {
  if (value.length === 0) return false;
  const needsLeftBoundary = WORD_CHARACTER.test(value[0] as string);
  const needsRightBoundary = WORD_CHARACTER.test(
    value[value.length - 1] as string,
  );
  let from = 0;
  for (;;) {
    const at = source.indexOf(value, from);
    if (at === -1) return false;
    const before = at > 0 ? source[at - 1] : undefined;
    const after = source[at + value.length];
    const leftOk =
      !needsLeftBoundary ||
      before === undefined ||
      !WORD_CHARACTER.test(before);
    const rightOk =
      !needsRightBoundary || after === undefined || !WORD_CHARACTER.test(after);
    if (leftOk && rightOk) return true;
    from = at + 1;
  }
}
