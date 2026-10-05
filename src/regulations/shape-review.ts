import type * as schema from "@/db/schema";
import { normalApprovalBlockers, verifyShapeState } from "./coastal-state";
import type { SourceRun } from "./coastal-state";
type Decision = typeof schema.regulationCaseValidations.$inferSelect;
export function shapeReview(
  revision: typeof schema.regulationCaseRevisions.$inferSelect,
  runs: readonly SourceRun[],
  decisions: readonly Decision[],
) {
  if (revision.geometryModelVersion !== 1)
    return {
      geometryModelVersion: 0 as const,
      coverage: null,
      shapes: [],
      shapeManifestHash: null,
      coverageValidated: false,
    };
  const state = verifyShapeState(revision.shapeState, revision.snapshotText, [
    ...runs,
  ]);
  const ordered = decisions
    .filter((d) => d.revisionId === revision.id)
    .sort((a, b) => (b.commandSequence ?? -1) - (a.commandSequence ?? -1));
  const legal = ordered.find((d) => d.scope === "legal");
  const coverage = ordered.find((d) => d.scope === "coverage");
  const coverageValidated =
    !!coverage?.validated &&
    coverage.coverageHash === state.coverage.coverageHash;
  const positive = new Map<string, string>();
  const latest = new Set<string>();
  for (const d of ordered)
    if (d.scope === "shape" && d.shapeId && !latest.has(d.shapeId)) {
      latest.add(d.shapeId);
      if (d.validated && d.shapeHash) positive.set(d.shapeId, d.shapeHash);
    }
  const blockers = normalApprovalBlockers(
    state,
    !!legal?.validated,
    coverageValidated,
    positive,
  );
  return {
    ...state,
    coverageValidated,
    regulatoryValidated: !!legal?.validated,
    shapes: state.shapes.map((s) => ({
      ...s,
      shapeValidated: positive.get(s.id) === s.shapeHash,
    })),
    approvalBlockers: blockers,
  };
}
