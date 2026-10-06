import { sha256Text } from "@/events/json-digest";
import { blockedShapeState } from "./blocked-shape-state";
import {
  type RevisionShape,
  type RevisionShapeState,
  type SourceRun,
  coverageDigest,
  manifestDigest,
  shapeDigest,
  verifyShapeState,
} from "./coastal-state";
import { revisionIdFor } from "./ids";

export class BoundaryResourceLimitError extends Error {}

export type PrintedRun = SourceRun & { paragraph: number | null };
const TOKEN =
  /Nord\s+(\d+)\s+grader\s+(\d+[.,]\d+)\s+minutter\.?\s+Øst\s+(\d+)\s+grader\s+(\d+[.,]\d+)\s+minutter\.?/giu;
const PREFIX =
  /^Det er forbudt å fiske etter sei med not i et område på [^\n]*?,?\s+avgrenset /iu;
const same = (a: SourceRun["points"], b: SourceRun["points"]) =>
  a.length === b.length &&
  a.every((p, i) => p.lat === b[i].lat && p.lon === b[i].lon);
const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** Clause inventory is independent of successful point parsing. Recognition is
 * deliberately narrow: complete stored sections, exact supported boundary text,
 * exact ordered raw membership. Human completeness confirmation stays separate. */
export function parseBoundaryInventory(
  identity: string,
  text: string | null,
  runs: PrintedRun[],
  sourceComplete: boolean | null,
): RevisionShapeState {
  if (
    runs.length > 512 ||
    runs.reduce((n, r) => n + r.points.length, 0) > 200_000
  )
    throw new BoundaryResourceLimitError("resource_limit: raw source runs");
  const state = blockedShapeState(
    identity,
    text,
    runs,
    sourceComplete,
    "unsupported_boundary",
  );
  const body = text ?? "";
  const headings = [...body.matchAll(/^\s*§\s*(\d+)\b[^\n]*\n/gmu)];
  const sections: Array<{
    start: number;
    end: number;
    paragraph: number | null;
    title: string;
  }> = headings.length
    ? headings.map((h, i) => ({
        start: h.index ?? 0,
        end: headings[i + 1]?.index ?? body.length,
        paragraph: Number(h[1]),
        title: h[0].trim(),
      }))
    : [
        {
          start: 0,
          end: body.length,
          paragraph: null,
          title: "Unsectioned source",
        },
      ];
  // Preserve preamble as an explicit inventory entry too. It cannot be assumed
  // legally irrelevant merely because it contains no successfully parsed points.
  if (headings.length && (headings[0].index ?? 0) > 0)
    sections.unshift({
      start: 0,
      end: headings[0].index ?? 0,
      paragraph: null,
      title: "Source preamble",
    });
  if (sections.length > 512)
    throw new BoundaryResourceLimitError(
      "resource_limit: source clause inventory",
    );
  state.shapes = [];
  state.coverage.clauses = [];
  const assigned = new Set<number>();
  for (const section of sections) {
    const quote = body.slice(section.start, section.end);
    const span = { start: section.start, end: section.end, quote };
    const template = blockedShapeState(
      `${identity}:${section.start}`,
      text,
      runs,
      sourceComplete,
      "unsupported_boundary",
    ).shapes[0];
    const shape: RevisionShape = {
      ...template,
      position: state.shapes.length,
      name: section.title,
      section: section.paragraph === null ? null : `§${section.paragraph}`,
    };
    shape.boundary.sourceSpans = [span];
    shape.boundary.parserVersion = "no-printed-boundary/1";
    shape.sourceRunPositions = [];
    const clause = {
      id: revisionIdFor(
        `source-clause:${identity}:${section.start}:${section.end}`,
      ),
      sourceSpan: span,
      required: true,
      shapeIds: [shape.id],
      issues: ["unsupported_boundary"],
    };
    const matches = [...quote.matchAll(TOKEN)];
    const points = matches.map((m) => ({
      lat: round(Number(m[1]) + Number(m[2].replace(",", ".")) / 60),
      lon: round(Number(m[3]) + Number(m[4].replace(",", ".")) / 60),
    }));
    const malformed =
      [...quote.matchAll(/\bNord\b/giu)].length !== matches.length ||
      matches.some(
        (m) =>
          Number(m[1]) > 90 ||
          Number(m[3]) > 180 ||
          Number(m[2].replace(",", ".")) >= 60 ||
          Number(m[4].replace(",", ".")) >= 60,
      );
    // Source rows historically carry no section identity. Bind them only by
    // exact complete printed point sequences in ordered whole raw runs. More
    // than one exact grouping is ambiguous; never match a nearby coordinate
    // or use a shape title as a legal boundary reference.
    const hinted = runs.filter(
      (r) => r.paragraph === section.paragraph && section.paragraph !== null,
    );
    const groups: PrintedRun[][] = [];
    if (hinted.length) {
      if (
        same(
          points,
          hinted.flatMap((r) => r.points),
        )
      )
        groups.push(hinted);
    } else if (points.length) {
      for (let start = 0; start < runs.length; start++) {
        const group: PrintedRun[] = [];
        let count = 0;
        for (
          let end = start;
          end < runs.length && count < points.length;
          end++
        ) {
          group.push(runs[end]);
          count += runs[end].points.length;
          if (
            count === points.length &&
            same(
              points,
              group.flatMap((r) => r.points),
            )
          )
            groups.push(group);
        }
      }
    }
    const sectionRuns = groups.length === 1 ? groups[0] : [];
    const flattened = sectionRuns.flatMap((r) => r.points);
    if (
      same(points, flattened) &&
      sectionRuns.every((r) => !assigned.has(r.position))
    ) {
      shape.sourceRunPositions = sectionRuns.map((r) => r.position);
      for (const r of sectionRuns) assigned.add(r.position);
    }
    const refs = sectionRuns.flatMap((r) =>
      r.points.map((_, pointIndex) => ({
        runPosition: r.position,
        pointIndex,
      })),
    );
    const paragraphBody = quote.replace(/^\s*§\s*\d+\b[^\n]*\n/u, "").trim();
    let mode: "west-east" | "coast-pairs" | null = null;
    let straight: number[][] = [];
    let coast: Array<[number, number]> = [];
    if (
      PREFIX.test(paragraphBody) &&
      !malformed &&
      same(points, flattened) &&
      refs.length === points.length &&
      shape.sourceRunPositions.length
    ) {
      const first = matches[0];
      const last = matches.at(-1);
      const prefix = first
        ? quote
            .slice(0, first.index)
            .replace(/^\s*§\s*\d+\b[^\n]*\n/u, "")
            .trim()
        : "";
      const tail = last
        ? quote.slice((last.index ?? 0) + last[0].length).trim()
        : "";
      const separators = matches
        .slice(0, -1)
        .map((m, i) =>
          quote.slice((m.index ?? 0) + m[0].length, matches[i + 1].index),
        );
      if (
        points.length === 4 &&
        sectionRuns.length === 2 &&
        sectionRuns.every((r) => r.points.length === 2) &&
        /avgrenset i vest av en rett linje mellom følgende posisjoner:\s*-?\s*$/iu.test(
          prefix,
        ) &&
        /^\s*herfra videre avgrenset i øst av rett linje mellom følgende posisjoner:\s*-?\s*$/iu.test(
          separators[1],
        ) &&
        separators
          .filter((_, i) => i !== 1)
          .every((s) => /^\s*-?\s*$/u.test(s)) &&
        /^[»”".\s]*$/u.test(tail)
      ) {
        mode = "west-east";
        straight = [
          [0, 1],
          [2, 3],
        ];
      } else if (
        sectionRuns.length === 1 &&
        points.length >= 3 &&
        /avgrenset av rette linjer mellom følgende posisjoner:\s*-?\s*$/iu.test(
          prefix,
        ) &&
        separators.every((s) => /^\s*-?\s*$/u.test(s))
      ) {
        const pairs =
          /^Mellom posisjon (\d+) og (\d+)(?: og mellom (\d+) og (\d+))? følger grensen kystlinjen[»”".\s]*$/iu.exec(
            tail,
          );
        if (pairs) {
          coast = [[Number(pairs[1]) - 1, Number(pairs[2]) - 1]];
          if (pairs[3])
            coast.push([Number(pairs[3]) - 1, Number(pairs[4]) - 1]);
          if (
            coast.every(
              ([a, b]) =>
                a >= 0 &&
                b >= 0 &&
                a < points.length &&
                b === (a + 1) % points.length,
            ) &&
            new Set(coast.map(([a]) => a)).size === coast.length
          ) {
            const removed = new Set(coast.map(([a]) => a));
            const start = (coast[0][0] + 1) % points.length;
            let run: number[] = [start];
            for (let k = 0; k < points.length; k++) {
              const a = (start + k) % points.length;
              const b = (a + 1) % points.length;
              if (removed.has(a)) {
                if (run.length >= 2) straight.push(run);
                run = [b];
              } else run.push(b);
            }
            if (straight.length === coast.length) mode = "coast-pairs";
          }
        }
      }
    }
    if (groups.length > 1) {
      shape.blockingReasons = ["ambiguous_source_group"];
      clause.issues = ["ambiguous_source_group"];
    } else if (malformed) {
      shape.blockingReasons = ["malformed_coordinate"];
      clause.issues = ["malformed_coordinate"];
    } else if (points.length && !shape.sourceRunPositions.length) {
      shape.blockingReasons = ["source_points_mismatch"];
      clause.issues = ["source_points_mismatch"];
    } else if (mode) {
      shape.boundary.mode = "lines-plus-coast";
      shape.boundary.straightRuns = straight.map((r) => r.map((i) => refs[i]));
      shape.boundary.coastEdges = coast.map(([a, b]) => [refs[a], refs[b]]);
      shape.boundary.interpretation =
        mode === "west-east"
          ? "Printed western and eastern lines proposed as one coastal enclosure. Admin must review this interpretation, all joins and enclosed faces."
          : "Printed adjacent coast edges omitted from straight linework; original endpoints retained. Admin must review all joins and enclosed faces.";
      shape.requiredEndpoints = shape.boundary.straightRuns.flatMap((r) => [
        r[0],
        r[r.length - 1],
      ]);
      shape.blockingReasons = ["joins_unselected"];
      clause.issues = [];
    }
    shape.provenance.sourceSnapshotHash = sha256Text(body);
    shape.shapeHash = shapeDigest(shape);
    state.shapes.push(shape);
    state.coverage.clauses.push(clause);
  }
  // Runs not uniquely bound to an exact source section remain visible evidence;
  // no fuzzy title/coordinate-nearness fallback claims they form a closure.
  state.coverage.coverageHash = coverageDigest(state.coverage);
  state.shapeManifestHash = manifestDigest(state);
  return verifyShapeState(state, text, runs);
}
