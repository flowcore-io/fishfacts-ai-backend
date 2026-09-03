/**
 * The Usable Chat embed API, as far as ingestion needs it: one message in, one
 * assembled answer out.
 *
 * This is the billing boundary, not a convenience wrapper. The embed key
 * carries a PAT identity, and usable-chat emits the `token-usage` billing
 * events for every call made through it — so a job that reads statutes through
 * here spends the customer's credits, where a direct model-provider call would
 * spend nobody's. That is why this module exists and why nothing in ingestion
 * may call a model provider directly.
 *
 * The response is an SSE stream even for a single-shot question. The answer is
 * the concatenation of `text-delta` events; `stream-end` carries the final
 * status. Everything else on the stream (intent, plan, persona-activation,
 * token-usage) is someone else's concern and is deliberately ignored here.
 *
 * Sessions are forced stateless on the PAT path (`persistenceStatus:
 * skipped-temporary`), so there is no conversation to continue — every call is
 * a fresh single turn, and callers must not design around multi-turn state.
 */

import type { Env } from "@/env";

/**
 * Generous on purpose: a statute read legitimately runs a couple of minutes
 * (the model streams several hundred vertices). What this bounds is the
 * pathological case — a stalled stream would otherwise hang the whole job run,
 * because `response.text()` waits for the socket to close and the job's own
 * stop check only runs between statutes.
 */
const EMBED_CHAT_TIMEOUT_MS = 5 * 60 * 1000;

export type EmbedChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/** One `data:` payload from the stream, only as far as we read into it. */
type StreamEvent = {
  type?: string;
  data?: {
    textDelta?: string;
    status?: string;
  };
};

/**
 * Assemble the answer text out of a complete SSE stream.
 *
 * Exported for tests: the interesting failures are in what we do with the
 * stream, not in the HTTP. Refuses a stream with no `stream-end` or a
 * non-`completed` status — a truncated answer looks exactly like a short one,
 * and this text becomes polygons downstream.
 */
export function assembleEmbedChatText(sse: string): string {
  let text = "";
  let endStatus: string | null = null;

  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line.slice("data: ".length));
    } catch {
      // Not every data line is guaranteed to stay JSON across usable-chat
      // releases; an unreadable frame of a type we don't consume must not
      // kill the ones we do.
      continue;
    }
    if (event.type === "text-delta") {
      text += event.data?.textDelta ?? "";
    } else if (event.type === "stream-end") {
      endStatus = event.data?.status ?? null;
    }
  }

  if (endStatus !== "completed") {
    throw new Error(
      `Embed chat stream ended with status ${JSON.stringify(endStatus)} — refusing a possibly truncated answer`,
    );
  }
  return text;
}

/**
 * One stateless embed chat turn. Throws on transport errors, on a non-2xx
 * response, and on a stream that did not complete.
 */
export async function postEmbedChat(
  env: Env,
  messages: EmbedChatMessage[],
): Promise<string> {
  const key = env.INGESTION_EMBED_KEY;
  if (!key) {
    throw new Error(
      "INGESTION_EMBED_KEY is not set — the Usable Chat embed API cannot be called",
    );
  }

  const url = `${env.USABLE_CHAT_EMBED_URL}?token=${encodeURIComponent(key)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(EMBED_CHAT_TIMEOUT_MS),
    });
  } catch (error) {
    // The key never goes into an error message; a thrown Error ends up in job
    // logs and job state fragments, and fetch rejections can echo the request
    // URL — which carries the token. Redact before rethrowing.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Embed chat request failed: ${detail.replaceAll(key, "<redacted>").replaceAll(encodeURIComponent(key), "<redacted>")}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Embed chat answered ${response.status}`);
  }
  return assembleEmbedChatText(await response.text());
}
