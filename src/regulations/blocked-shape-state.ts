import { sha256Text } from "@/events/json-digest";
import {
  type RevisionShapeState,
  type SourceRun,
  coverageDigest,
  manifestDigest,
  shapeDigest,
  sourceRunManifestHashOf,
  verifyShapeState,
} from "./coastal-state";
import { revisionIdFor } from "./ids";

/** A changed source/run never inherits old geometry. The whole stored source
 * remains a required unresolved inventory entry until bounded reconstruction
 * produces an independently reviewable clause inventory. Zero points survive. */
export function blockedShapeState(
  identity: string,
  text: string | null,
  runs: SourceRun[],
  complete: boolean | null,
  reason:
    | "unsupported_boundary"
    | "source_points_mismatch" = "source_points_mismatch",
): RevisionShapeState {
  const span = { start: 0, end: (text ?? "").length, quote: text ?? "" };
  const hash = sha256Text(text ?? "");
  const shapeId = revisionIdFor(`blocked-shape:${identity}`);
  const state: RevisionShapeState = {
    geometryModelVersion: 1,
    shapeManifestHash: "",
    coverage: {
      sourceSnapshotHash: hash,
      sourceAvailability:
        text === null
          ? "missing"
          : complete === false || text.length >= 500_000
            ? "known_incomplete"
            : "complete_snapshot",
      coverageHash: "",
      clauses: [
        {
          id: revisionIdFor(`blocked-clause:${identity}`),
          sourceSpan: span,
          required: true,
          shapeIds: [shapeId],
          issues: [reason, "full_source_inventory_pending"],
        },
      ],
    },
    shapes: [
      {
        id: shapeId,
        position: 0,
        name: null,
        section: null,
        kind: "closure",
        sourceRunPositions: runs.map((r) => r.position),
        boundary: {
          mode: "unsupported",
          parserVersion: "unresolved-source/1",
          sourceSpans: [span],
          interpretation:
            "Source or ordered point runs changed; complete boundary interpretation requires review.",
          straightRuns: [],
          coastEdges: [],
        },
        status: "blocked",
        blockingReasons: [reason],
        geojson: null,
        shapeHash: "",
        requiredEndpoints: [],
        joinCandidates: [],
        candidateEnumerationComplete: false,
        selectedJoinCandidateIds: [],
        joinConfigurationHash: null,
        faceCandidates: [],
        faceEnumerationComplete: false,
        selectedFaceIds: [],
        provenance: {
          sourceSnapshotHash: hash,
          landDatasetId: null,
          algorithmVersion: "blocked-source/1",
          engineVersions: { postgis: "unused", geos: "unused", proj: "unused" },
          frame: null,
          parameters: { sourceRunManifestHash: sourceRunManifestHashOf(runs) },
          justification: null,
        },
      },
    ],
  };
  state.coverage.coverageHash = coverageDigest(state.coverage);
  state.shapes[0].shapeHash = shapeDigest(state.shapes[0]);
  state.shapeManifestHash = manifestDigest(state);
  return verifyShapeState(state, text, runs);
}
