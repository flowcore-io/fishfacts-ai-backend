import { describe, expect, test } from "bun:test";
import {
  buildVerdictMessages,
  parseVerdictAnswer,
  verdictConfidenceOf,
} from "./verdict";

const VALID_ISSUE = {
  field: "§ 2, stk. 1, nr. 3",
  kind: "underdetermined_boundary",
  ref: "315° rættvísandi úr Barðinum",
  confidence: 0.9,
};

describe("parseVerdictAnswer", () => {
  test("accepts a schema-valid issue list", () => {
    const parsed = parseVerdictAnswer(
      JSON.stringify({ issues: [VALID_ISSUE] }),
    );
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.issues[0]?.kind).toBe("underdetermined_boundary");
  });

  test("accepts an explicit clean bill", () => {
    const parsed = parseVerdictAnswer(
      JSON.stringify({
        issues: [{ field: "overall", kind: "ok", ref: null, confidence: 1 }],
      }),
    );
    expect(parsed.status).toBe("ok");
  });

  test("peels a fence but otherwise refuses prose", () => {
    const fenced = `\`\`\`json\n${JSON.stringify({ issues: [VALID_ISSUE] })}\n\`\`\``;
    expect(parseVerdictAnswer(fenced).status).toBe("ok");
    expect(parseVerdictAnswer("The statute looks fine to me.").status).toBe(
      "failed",
    );
  });

  test("an empty issue list fails closed — silence is not a clean bill", () => {
    // A clean document gets an explicit overall/ok entry; a model answering
    // {"issues": []} did not follow the instructions and vouched for nothing.
    expect(parseVerdictAnswer(JSON.stringify({ issues: [] })).status).toBe(
      "failed",
    );
  });

  test("fails closed on an unknown kind", () => {
    // The old four-kind taxonomy still lives in the embed config's prompt; an
    // answer written to it must be recorded as failed, not coerced.
    const parsed = parseVerdictAnswer(
      JSON.stringify({
        issues: [{ ...VALID_ISSUE, kind: "somewhat_unclear" }],
      }),
    );
    expect(parsed.status).toBe("failed");
  });

  test("fails closed on a confidence outside 0..1", () => {
    const parsed = parseVerdictAnswer(
      JSON.stringify({ issues: [{ ...VALID_ISSUE, confidence: 7 }] }),
    );
    expect(parsed.status).toBe("failed");
  });
});

describe("verdictConfidenceOf", () => {
  test("is the minimum issue confidence — the shakiest claim", () => {
    expect(
      verdictConfidenceOf([
        { ...VALID_ISSUE, confidence: 0.9 },
        { ...VALID_ISSUE, confidence: 0.4 },
      ] as never),
    ).toBe(0.4);
  });

  test("is null with nothing to be confident about", () => {
    expect(verdictConfidenceOf([])).toBeNull();
  });
});

describe("buildVerdictMessages", () => {
  test("one user message carrying the taxonomy and the text", () => {
    const messages = buildVerdictMessages({
      title: "Kunngerð nr. 45 (2022)",
      jurisdiction: "FO",
      text: "§ 2. Loyvt er ikki …",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("underdetermined_boundary");
    expect(messages[0]?.content).toContain("external_reference");
    expect(messages[0]?.content).toContain("§ 2. Loyvt er ikki …");
  });
});
