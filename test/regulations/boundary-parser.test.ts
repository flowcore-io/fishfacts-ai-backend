import { expect, test } from "bun:test";
import { parseBoundaryInventory } from "../../src/regulations/boundary-parser";
import fixture from "./fixtures/printed-coastal-excerpts.json";

test("exact west/east and coast-edge clauses bind their original global ordered runs without selecting anything", () => {
  const text = `${fixture.source.p1}\n\n${fixture.source.p6}`;
  const state = parseBoundaryInventory("excerpt", text, fixture.runs, false);
  expect(state.coverage.sourceAvailability).toBe("known_incomplete");
  expect(state.shapes).toHaveLength(2);
  for (const s of state.shapes) {
    expect(s.boundary.mode).toBe("lines-plus-coast");
    expect(s.requiredEndpoints).toHaveLength(4);
    expect(s.selectedJoinCandidateIds).toEqual([]);
    expect(s.selectedFaceIds).toEqual([]);
    expect(s.geojson).toBeNull();
    expect(s.boundary.sourceSpans[0].quote).toBe(
      text.slice(
        s.boundary.sourceSpans[0].start,
        s.boundary.sourceSpans[0].end,
      ),
    );
  }
  expect(state.shapes[0].sourceRunPositions).toEqual([0, 1]);
  expect(state.shapes[1].sourceRunPositions).toEqual([6]);
  expect(state.shapes[1].boundary.coastEdges).toEqual([
    [
      { runPosition: 6, pointIndex: 5 },
      { runPosition: 6, pointIndex: 6 },
    ],
    [
      { runPosition: 6, pointIndex: 7 },
      { runPosition: 6, pointIndex: 0 },
    ],
  ]);
});

test("plain lists, unknown exception, malformed token and zero-point sections remain independent blocked entries", () => {
  for (const replacement of [
    fixture.source.p6.replace(/Mellom posisjon[\s\S]*/, ""),
    `${fixture.source.p6} Unntatt en grense som følger en annen linje.`,
    fixture.source.p6.replace("6.850", "6,.850"),
  ]) {
    const state = parseBoundaryInventory(
      "unknown",
      `${replacement}\n\n§ 99 Ukjent\nGrensen følger et navngitt sted.`,
      fixture.runs.filter((r) => r.paragraph === 6),
      true,
    );
    expect(state.shapes).toHaveLength(2);
    expect(
      state.shapes.every((s) => s.status === "blocked" && s.geojson === null),
    ).toBe(true);
    expect(state.shapes[0].boundary.mode).toBe("unsupported");
    expect(state.shapes[1].sourceRunPositions).toEqual([]);
    expect(state.coverage.clauses[1].required).toBe(true);
  }
});

test("printed endpoint/intermediate typo cannot be repaired by matching nearby raw data; UTF16 inventory includes preamble", () => {
  const text = `🐟 Source intro\n${fixture.source.p6.replace("6.850", "6.851")}`;
  const state = parseBoundaryInventory(
    "changed",
    text,
    fixture.runs.filter((r) => r.paragraph === 6),
    true,
  );
  expect(state.shapes).toHaveLength(2);
  expect(state.shapes[1].blockingReasons).toContain("source_points_mismatch");
  expect(state.coverage.clauses.map((c) => c.sourceSpan.quote).join("")).toBe(
    text,
  );
});

test("raw case rows without paragraph labels bind only one exact whole ordered point group", () => {
  const text = `${fixture.source.p1}\n\n${fixture.source.p6}`;
  const runs = fixture.runs.map((r) => ({ ...r, paragraph: null }));
  const state = parseBoundaryInventory("raw-rows", text, runs, false);
  expect(state.shapes.map((s) => s.boundary.mode)).toEqual([
    "lines-plus-coast",
    "lines-plus-coast",
  ]);
  expect(state.shapes.map((s) => s.sourceRunPositions)).toEqual([[0, 1], [6]]);
  const duplicate = [
    ...runs,
    ...runs.map((r) => ({ ...r, position: r.position + 100 })),
  ];
  const ambiguous = parseBoundaryInventory("ambiguous", text, duplicate, false);
  expect(ambiguous.shapes.every((s) => s.geojson === null)).toBe(true);
  expect(
    ambiguous.coverage.clauses.some((c) =>
      c.issues.includes("ambiguous_source_group"),
    ),
  ).toBe(true);
});
