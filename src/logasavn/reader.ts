/**
 * The reader half: an LLM saying what a statute MEANS.
 *
 * It is the author here, and `extractAreas` is the cross-check — the inverse of
 * the arrangement this pipeline started with, and the inversion was measured
 * rather than assumed. Given only the corpus and no scaffolding, a model
 * matched the parser on all ten vertices of `K 35/2026` to twelve decimal
 * places, twice, and also found the semantic inversion the parser was
 * structurally incapable of seeing: `K 113/2014`'s Skjal 1 tables are the
 * EXISTING FISHING GROUNDS, and the pipeline was drawing them as closures.
 *
 * What it is NOT trusted with is arithmetic. Every vertex comes back as the
 * statute's own text and is converted by the same tokenizer the parser uses, so
 * the gate in `closure-reading.ts` compares transcription and nothing else. See
 * `VERTEX_TOLERANCE_DEGREES` for why that distinction is load-bearing.
 */

import type { Env } from "@/env";
import { z } from "zod";
import type { StatuteReading } from "./closure-reading";

/**
 * How a statute gets read.
 *
 * An interface rather than a concrete client so the job can be tested against a
 * fake with no key, no network and no spend — the same seam `LogasavnSweepUsable`
 * uses, and for the same reason: the interesting failures are in what we do with
 * the answer, not in the HTTP.
 */
export type StatuteReader = (statute: {
  title: string;
  body: string;
  url: string | null;
}) => Promise<StatuteReading>;

const vertexSchema = z.object({
  lat: z.string().min(1),
  lon: z.string().min(1),
});

const ringSchema = z.object({
  section: z.string().min(1),
  name: z.string().nullable(),
  kind: z.enum(["closure", "exemption", "other"]),
  season: z.string().nullable(),
  vertices: z.array(vertexSchema),
});

export const statuteReadingSchema = z.object({
  inForce: z.boolean(),
  summary: z.string().min(1),
  rings: z.array(ringSchema),
});

/**
 * The same shape as `statuteReadingSchema`, for OpenRouter's structured output.
 *
 * Duplicated deliberately rather than generated: the model is steered by these
 * `description` strings as much as by the prompt, and they say things the zod
 * schema has no way to express — that a coordinate must be copied rather than
 * converted, and that case is meaning. A generator would drop exactly the part
 * that is doing the work.
 */
const READING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["inForce", "summary", "rings"],
  properties: {
    inForce: {
      type: "boolean",
      description:
        "True only if the statute's validity_status is Galdandi. Áður galdandi means superseded.",
    },
    summary: {
      type: "string",
      description:
        "ONE plain-language sentence a fisherman can act on, naming what the statute actually does. If it is a permit or fishing-day regime rather than a closure, say so.",
    },
    rings: {
      type: "array",
      description:
        "One entry per coordinate ring the statute lists. Include EVERY ring, including ones that are not closures — an omitted ring cannot be cross-checked.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "name", "kind", "season", "vertices"],
        properties: {
          section: {
            type: "string",
            description:
              'Where it is written, as the statute writes it: "§ 5, stk. 1".',
          },
          name: {
            type: ["string", "null"],
            description:
              'The statute\'s own name for the area ("Øki A", "øki a", "HAR 1"), copied EXACTLY. Case is meaning: "Øki A" is a closure and "øki a" is the water inside it where fishing is allowed. Never change the case. Null if the statute gives no name.',
          },
          kind: {
            type: "string",
            enum: ["closure", "exemption", "other"],
            description:
              'closure = fishing is prohibited inside this ring. exemption = this ring is inside a closure and the same statute REOPENS it. other = anything else, including tables of existing fishing grounds ("verandi fiskileiðir"), territorial baselines, and areas that merely define where a permit regime applies.',
          },
          season: {
            type: ["string", "null"],
            description:
              'The season as printed ("1. september - 31. mai"), or null if it applies year-round. "frá 00.00 til 23.59" is a time of day, not a date range.',
          },
          vertices: {
            type: "array",
            description:
              "The ring's vertices, in the order the statute lists them. Do not reorder, do not close the ring yourself, do not skip any.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["lat", "lon"],
              properties: {
                lat: {
                  type: "string",
                  description:
                    'The latitude COPIED CHARACTER FOR CHARACTER from the statute, e.g. "60°57\'20\\"N" or "61°13,333\'N". Never convert to decimal degrees, never round, never correct what looks wrong.',
                },
                lon: {
                  type: "string",
                  description:
                    'The longitude copied character for character, e.g. "07°57\'00\\"V". V (vestur) means west — keep the letter as printed rather than converting it to a sign.',
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * What the reader is told before it sees a statute.
 *
 * These are the five rules from the closures skill (`63652773`), which were
 * derived from real corpus failures rather than written in the abstract. The
 * "copy, do not convert" rule is the one this pipeline adds a mechanism behind:
 * the quotes are re-parsed and compared, so an instruction the model drifts from
 * fails closed instead of drawing.
 */
export const READER_SYSTEM_PROMPT = `You are reading Faroese fisheries law (Lógasavn, a mirror of logir.fo) so that closure areas can be drawn on a nautical chart. Skippers act on the result.

Rules, in order of importance:

1. COPY COORDINATES, NEVER CONVERT THEM. Reproduce each vertex exactly as the statute prints it, including the degree sign, the minute/second marks and the hemisphere letter (V = vestur = west). Do not compute decimal degrees. Do not round. Do not "fix" a coordinate that looks wrong — report it as printed.

2. CASE IS MEANING. "Øki A" and "øki a" are different areas: the capital is a closure, the lowercase is the water inside it that the same statute reopens seasonally. Copy names exactly.

3. A RING IS NOT AUTOMATICALLY A CLOSURE. Read what the section actually prohibits. Tables headed "Knattstøður fyri verandi fiskileiðir" are EXISTING FISHING GROUNDS — water where fishing is permitted — and marking them as closures closes the open sea and opens the closed. Statutes about baselines, territorial limits, spring water and telecoms also carry coordinates.

4. LIST EVERY RING, including the ones that are not closures. Mark them "other" or "exemption". A ring you leave out cannot be cross-checked against the parser, and silence is indistinguishable from a ring you missed.

5. IN FORCE IS NOT THE SAME AS ACTIVE TODAY. "inForce" is about the statute's validity_status only. Seasonal windows go in "season", copied as printed.

If a vertex is written in a notation you cannot read confidently, copy the characters anyway — do not guess at what it should say. Downstream will withhold it.`;

export function buildReaderMessages(statute: {
  title: string;
  body: string;
  url: string | null;
}) {
  return [
    { role: "system" as const, content: READER_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `Statute: ${statute.title}${statute.url ? `\nSource: ${statute.url}` : ""}\n\n---\n\n${statute.body}`,
    },
  ];
}

/**
 * Validate what came back.
 *
 * A malformed reading is refused rather than partially salvaged: this output
 * becomes polygons, and "the rings we could parse out of the answer" is a
 * quietly incomplete statute, which is the exact failure ingest exists to end.
 */
export function parseReaderResponse(value: unknown): StatuteReading {
  return statuteReadingSchema.parse(value);
}

/** OpenRouter's chat-completions envelope, only as far as we read into it. */
const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

export function createOpenRouterReader(env: Env): StatuteReader {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Refused here rather than at boot: the service must start without a key so
    // that every other job keeps running, and only this one job is unavailable.
    return async () => {
      throw new Error(
        "OPENROUTER_API_KEY is not set — the Lógasavn closure reader cannot run",
      );
    };
  }

  return async function readStatute(statute) {
    const response = await fetch(
      `${env.OPENROUTER_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.LOGASAVN_READER_MODEL,
          // Nothing here is a matter of taste, so sampling should not vary the
          // answer. The same statute read twice must give the same rings.
          temperature: 0,
          messages: buildReaderMessages(statute),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "statute_reading",
              strict: true,
              schema: READING_JSON_SCHEMA,
            },
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `OpenRouter answered ${response.status} reading "${statute.title}"`,
      );
    }
    const completion = completionSchema.parse(await response.json());
    const content = completion.choices[0]?.message.content ?? "";
    return parseReaderResponse(JSON.parse(content));
  };
}
