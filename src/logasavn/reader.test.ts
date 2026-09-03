import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import {
  buildReaderMessages,
  createEmbedChatReader,
  stripAnswerFence,
} from "./reader";

describe("stripAnswerFence", () => {
  test("leaves bare JSON alone", () => {
    expect(stripAnswerFence('{"inForce":true}')).toBe('{"inForce":true}');
  });

  test("peels a single json fence", () => {
    expect(stripAnswerFence('```json\n{"inForce":true}\n```')).toBe(
      '{"inForce":true}',
    );
  });

  test("peels an unlabelled fence", () => {
    expect(stripAnswerFence('```\n{"inForce":true}\n```')).toBe(
      '{"inForce":true}',
    );
  });

  test("does not touch a fence inside the answer", () => {
    // A fence mid-answer is content, not transport noise — judged downstream.
    const answer = '{"summary":"see ```code``` above"}';
    expect(stripAnswerFence(answer)).toBe(answer);
  });
});

describe("buildReaderMessages", () => {
  test("one user message carrying rules, schema and statute", () => {
    const messages = buildReaderMessages({
      title: "Kunngerð nr. 45 (2022)",
      body: "§ 2. Loyvt er ikki …",
      url: "https://logir.fo/Kunngerd/45-fra-06-04-2022",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("COPY COORDINATES");
    expect(messages[0]?.content).toContain('"inForce"');
    expect(messages[0]?.content).toContain("Kunngerð nr. 45 (2022)");
    expect(messages[0]?.content).toContain("§ 2. Loyvt er ikki …");
  });
});

describe("createEmbedChatReader", () => {
  test("refuses to read without the embed key", async () => {
    const read = createEmbedChatReader({
      INGESTION_EMBED_KEY: undefined,
    } as Env);
    expect(
      read({ title: "Kunngerð nr. 45 (2022)", body: "…", url: null }),
    ).rejects.toThrow("INGESTION_EMBED_KEY");
  });
});
