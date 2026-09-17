import { describe, expect, test } from "bun:test";
import {
  APPLICABILITY_DIMENSIONS,
  regulationApplicabilitySchema,
} from "./applicability";

describe("regulationApplicabilitySchema", () => {
  test("still parses a record stored before evidence and notes existed", () => {
    const stored = {
      species: ["torsk"],
      gear: ["torsketrål"],
      vesselLength: { max: "15 m" },
      activity: "prohibited" as const,
    };
    const parsed = regulationApplicabilitySchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(stored);
    expect(parsed.data.evidence).toBeUndefined();
    expect(parsed.data.notes).toBeUndefined();
  });

  test("parses the new shape, quote per dimension and a note to the admin", () => {
    const parsed = regulationApplicabilitySchema.safeParse({
      gear: ["torsketrål"],
      evidence: { gear: "forbud mot å fiske med torsketrål" },
      notes: "Ingen lengdegrense oppgitt i teksten.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.evidence?.gear).toBe(
      "forbud mot å fiske med torsketrål",
    );
    expect(parsed.data.notes).toBe("Ingen lengdegrense oppgitt i teksten.");
  });

  test("a source that states nothing is an empty object, not an error", () => {
    expect(regulationApplicabilitySchema.safeParse({}).success).toBe(true);
  });

  test("refuses an empty quote — a blank is not evidence", () => {
    expect(
      regulationApplicabilitySchema.safeParse({
        gear: ["garn"],
        evidence: { gear: "" },
      }).success,
    ).toBe(false);
  });

  test("evidence covers exactly the dimensions, so neither can drift", () => {
    const evidenceShape = regulationApplicabilitySchema.shape.evidence;
    const evidenceKeys = Object.keys(evidenceShape.unwrap().shape).toSorted();
    expect(evidenceKeys).toEqual([...APPLICABILITY_DIMENSIONS].toSorted());
  });

  test("the dimension list is the schema's own keys, minus the two additions", () => {
    const schemaKeys = Object.keys(regulationApplicabilitySchema.shape)
      .filter((key) => key !== "evidence" && key !== "notes")
      .toSorted();
    expect(schemaKeys).toEqual([...APPLICABILITY_DIMENSIONS].toSorted());
  });
});
