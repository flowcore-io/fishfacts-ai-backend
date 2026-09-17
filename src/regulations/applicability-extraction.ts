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
 * come back as "trawl" — the broadening is invisible to an admin skimming a
 * list and would put the wrong vessels inside a closure. So every stated
 * dimension has to arrive with a quote, and the quote has to be findable in
 * the source text character-for-character: no case folding, no accent
 * normalisation, no whitespace collapsing. A model that paraphrases its own
 * evidence has already stopped copying, and the whole case is refused rather
 * than half of it kept (a partial proposal is the shape an admin trusts
 * least — it looks complete).
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
3. Every key you state MUST have an entry in "evidence" holding a quote COPIED CHARACTER-FOR-CHARACTER out of the text above, long enough to contain the value. An answer whose quote cannot be found in the text verbatim is discarded in full.
4. Put whole conditions into "exemptions" as they read ("fartøy under 15 meter som fisker med garn"), rather than splitting one condition across several keys where it becomes a different rule.
5. Use "notes" to tell the reviewer what you could not determine and why, or which other regulation they have to consult. If the text states no applicability at all, return {"notes": "..."} and nothing else.`;

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
 * `stale_base`) — these two are about the answer itself. */
export type ApplicabilityFailureReason = "unparseable" | "quote_not_in_source";

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

  const applicability = result.data;
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
