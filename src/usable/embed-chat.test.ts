import { describe, expect, test } from "bun:test";
import { assembleEmbedChatText } from "./embed-chat";

/** A stream frame the way usable-chat writes one. */
function frame(type: string, data: Record<string, unknown>): string {
  return `event: message\ndata: ${JSON.stringify({ type, data })}\n`;
}

const COMPLETED = frame("stream-end", { status: "completed" });

describe("assembleEmbedChatText", () => {
  test("concatenates text-delta events in order", () => {
    const sse = [
      frame("job-started", { persistenceStatus: "skipped-temporary" }),
      frame("text-delta", { textDelta: '{"ok":' }),
      frame("text-delta", { textDelta: "true}" }),
      COMPLETED,
    ].join("\n");
    expect(assembleEmbedChatText(sse).text).toBe('{"ok":true}');
  });

  test("ignores event types it does not consume", () => {
    const sse = [
      frame("intent", { intent: "information-seeking" }),
      frame("token-usage", { promptTokens: 20349 }),
      frame("text-delta", { textDelta: "answer" }),
      frame("summary", { text: "Completed" }),
      COMPLETED,
    ].join("\n");
    expect(assembleEmbedChatText(sse).text).toBe("answer");
  });

  test("survives a non-JSON data line without dropping the answer", () => {
    const sse = [
      "data: [heartbeat]\n",
      frame("text-delta", { textDelta: "answer" }),
      COMPLETED,
    ].join("\n");
    expect(assembleEmbedChatText(sse).text).toBe("answer");
  });

  test("refuses a stream with no stream-end", () => {
    // A truncated stream looks exactly like a short answer; the missing
    // terminator is the only tell.
    const sse = frame("text-delta", { textDelta: "half an ans" });
    expect(() => assembleEmbedChatText(sse)).toThrow("stream ended");
  });

  test("refuses a stream that ended with an error status", () => {
    const sse = [
      frame("text-delta", { textDelta: "partial" }),
      frame("stream-end", { status: "error" }),
    ].join("\n");
    expect(() => assembleEmbedChatText(sse)).toThrow('"error"');
  });
});
