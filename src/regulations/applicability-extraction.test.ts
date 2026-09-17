import { describe, expect, test } from "bun:test";
import {
  APPLICABILITY_INSTRUCTIONS,
  buildApplicabilityMessages,
  parseApplicabilityAnswer,
  statedDimensionsOf,
} from "./applicability-extraction";

/** A real J-melding sentence: the one that must never come back as "trål". */
const SOURCE = [
  "J-39-2026: Forskrift om forbud mot å fiske med torsketrål på Røstbanken.",
  "Det er forbudt å fiske med torsketrål i området avgrenset av rette linjer",
  "mellom posisjonene. Forbudet gjelder ikke fartøy under 15 meter som fisker",
  "med garn.",
].join("\n");

describe("parseApplicabilityAnswer", () => {
  test("accepts a stated dimension whose quote is verbatim in the source", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({
        gear: ["torsketrål"],
        activity: "prohibited",
        evidence: {
          gear: "Det er forbudt å fiske med torsketrål",
          activity: "Det er forbudt å fiske med torsketrål",
        },
      }),
      SOURCE,
    );
    expect(extraction.kind).toBe("proposal");
    if (extraction.kind !== "proposal") return;
    expect(extraction.applicability.gear).toEqual(["torsketrål"]);
    expect(extraction.applicability.activity).toBe("prohibited");
  });

  test("peels a ```json fence", () => {
    const answer = `\`\`\`json\n${JSON.stringify({ notes: "Ingen avgrensing oppgitt." })}\n\`\`\``;
    expect(parseApplicabilityAnswer(answer, SOURCE).kind).toBe("proposal");
  });

  test("a rule-less text yields a note and no dimension at all", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({ notes: "Teksten oppgir ingen avgrensing." }),
      SOURCE,
    );
    expect(extraction.kind).toBe("proposal");
    if (extraction.kind !== "proposal") return;
    expect(statedDimensionsOf(extraction.applicability)).toEqual([]);
    expect(extraction.applicability.notes).toBe(
      "Teksten oppgir ingen avgrensing.",
    );
  });

  test("an empty answer is a proposal, not a failure", () => {
    expect(parseApplicabilityAnswer("{}", SOURCE).kind).toBe("proposal");
  });

  test("refuses a broadened value — 'trål' when the text only says 'torsketrål'", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({
        gear: ["trål"],
        evidence: { gear: "Det er forbudt å fiske med trål" },
      }),
      SOURCE,
    );
    expect(extraction.kind).toBe("failed");
    if (extraction.kind !== "failed") return;
    expect(extraction.reason).toBe("quote_not_in_source");
    expect(extraction.detail).toContain("gear");
  });

  test("refuses a stated dimension with no quote at all, naming it", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({
        gear: ["torsketrål"],
        species: ["torsk"],
        evidence: { gear: "fiske med torsketrål" },
      }),
      SOURCE,
    );
    expect(extraction.kind).toBe("failed");
    if (extraction.kind !== "failed") return;
    expect(extraction.reason).toBe("quote_not_in_source");
    expect(extraction.detail).toContain("species");
    expect(extraction.detail).not.toContain("gear:");
  });

  test("the quote check is exact — no case folding, accents or whitespace slack", () => {
    const answers = [
      { gear: ["torsketrål"], evidence: { gear: "FISKE MED TORSKETRÅL" } },
      { gear: ["torsketrål"], evidence: { gear: "fiske med torsketral" } },
      { gear: ["torsketrål"], evidence: { gear: "fiske  med torsketrål" } },
    ];
    for (const answer of answers) {
      const extraction = parseApplicabilityAnswer(
        JSON.stringify(answer),
        SOURCE,
      );
      expect(extraction.kind).toBe("failed");
      if (extraction.kind !== "failed") continue;
      expect(extraction.reason).toBe("quote_not_in_source");
    }
  });

  test("keeps a whole condition in exemptions when it is quoted whole", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({
        exemptions: ["fartøy under 15 meter som fisker\nmed garn"],
        evidence: {
          exemptions: "Forbudet gjelder ikke fartøy under 15 meter som fisker",
        },
      }),
      SOURCE,
    );
    expect(extraction.kind).toBe("proposal");
  });

  test("drops a quote for a dimension the answer does not state", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({
        gear: ["torsketrål"],
        evidence: {
          gear: "fiske med torsketrål",
          species: "Røstbanken",
        },
      }),
      SOURCE,
    );
    expect(extraction.kind).toBe("proposal");
    if (extraction.kind !== "proposal") return;
    expect(extraction.applicability.evidence).toEqual({
      gear: "fiske med torsketrål",
    });
  });

  test("drops the evidence block entirely when nothing is stated", () => {
    const extraction = parseApplicabilityAnswer(
      JSON.stringify({
        notes: "Ingenting oppgitt.",
        evidence: { gear: "Røstbanken" },
      }),
      SOURCE,
    );
    expect(extraction.kind).toBe("proposal");
    if (extraction.kind !== "proposal") return;
    expect(extraction.applicability.evidence).toBeUndefined();
  });

  test("prose and an off-schema answer are unparseable, not proposals", () => {
    const prose = parseApplicabilityAnswer(
      "This regulation applies to cod trawlers.",
      SOURCE,
    );
    expect(prose.kind).toBe("failed");
    if (prose.kind === "failed") expect(prose.reason).toBe("unparseable");

    const offSchema = parseApplicabilityAnswer(
      JSON.stringify({ activity: "forbidden" }),
      SOURCE,
    );
    expect(offSchema.kind).toBe("failed");
    if (offSchema.kind === "failed") {
      expect(offSchema.reason).toBe("unparseable");
      expect(offSchema.detail).toContain("activity");
    }
  });
});

describe("buildApplicabilityMessages", () => {
  test("carries the instructions, the heading and the text in one turn", () => {
    const messages = buildApplicabilityMessages({
      title: "Forbud mot å fiske med torsketrål på Røstbanken",
      jurisdiction: "NO",
      text: SOURCE,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain(APPLICABILITY_INSTRUCTIONS);
    expect(messages[0]?.content).toContain("(NO): Forbud mot å fiske");
    expect(messages[0]?.content).toContain(SOURCE);
  });

  test("the prompt spells out the two rules the spike turned on", () => {
    expect(APPLICABILITY_INSTRUCTIONS).toContain("OMIT any key");
    expect(APPLICABILITY_INSTRUCTIONS).toContain("CHARACTER-FOR-CHARACTER");
  });
});
