import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sha256Text } from "@/events/json-digest";
import {
  type ApprovalEvidence,
  verifyApprovalEvidence,
} from "./approval-evidence";
import {
  type RevisionShapeState,
  coverageDigest,
  manifestDigest,
  normalApprovalBlockers,
  shapeDigest,
  sourceRunManifestHashOf,
  sourceSignatureOf,
  verifyShapeState,
} from "./coastal-state";
const text =
  "Complete synthetic source 😀\nBoth closed areas exclude their interior islands.";
const runs = [
  {
    position: 0,
    points: [
      { lon: 10, lat: 60 },
      { lon: 11, lat: 60 },
      { lon: 11, lat: 61 },
      { lon: 10, lat: 61 },
    ],
  },
];
const stamp = (state: RevisionShapeState) => {
  state.coverage.coverageHash = coverageDigest(state.coverage);
  for (const s of state.shapes) s.shapeHash = shapeDigest(s);
  state.shapeManifestHash = manifestDigest(state);
  return state;
};
function fixture(): RevisionShapeState {
  const id = randomUUID();
  const sourceSnapshotHash = sha256Text(text);
  return stamp({
    geometryModelVersion: 1,
    coverage: {
      sourceSnapshotHash,
      sourceAvailability: "complete_snapshot",
      clauses: [
        {
          id: randomUUID(),
          sourceSpan: { start: 0, end: text.length, quote: text },
          required: true,
          shapeIds: [id],
          issues: [],
        },
      ],
      coverageHash: "",
    },
    shapeManifestHash: "",
    shapes: [
      {
        id,
        position: 0,
        name: null,
        section: null,
        kind: "closure",
        sourceRunPositions: [0],
        boundary: {
          mode: "straight-ring",
          parserVersion: "fixture/1",
          sourceSpans: [{ start: 0, end: text.length, quote: text }],
          interpretation: "Synthetic explicit ring",
          straightRuns: [
            runs[0].points.map((_, pointIndex) => ({
              runPosition: 0,
              pointIndex,
            })),
          ],
          coastEdges: [],
        },
        status: "proposed",
        blockingReasons: [],
        geojson: {
          type: "MultiPolygon",
          coordinates: [
            [
              [
                [10, 60],
                [11, 60],
                [11, 61],
                [10, 61],
                [10, 60],
              ],
              [
                [10.2, 60.2],
                [10.2, 60.3],
                [10.3, 60.3],
                [10.3, 60.2],
                [10.2, 60.2],
              ],
            ],
            [
              [
                [12, 60],
                [13, 60],
                [13, 61],
                [12, 61],
                [12, 60],
              ],
            ],
          ],
        },
        shapeHash: "",
        requiredEndpoints: [],
        joinCandidates: [],
        candidateEnumerationComplete: true,
        selectedJoinCandidateIds: [],
        joinConfigurationHash: null,
        faceCandidates: [],
        faceEnumerationComplete: true,
        selectedFaceIds: [],
        provenance: {
          sourceSnapshotHash,
          landDatasetId: null,
          algorithmVersion: "fixture/1",
          engineVersions: { postgis: "test", geos: "test", proj: "test" },
          frame: null,
          parameters: { sourceRunManifestHash: sourceRunManifestHashOf(runs) },
          justification: "Synthetic fixture",
        },
      },
    ],
  });
}
describe("immutable full-shape evidence and approval gate", () => {
  test("full holes/pieces survive hash verification; exact source UTF16 span and ordered-run identity bind all coordinates", () => {
    const s = fixture();
    expect(verifyShapeState(s, text, runs)).toEqual(s);
    expect(
      normalApprovalBlockers(
        s,
        true,
        true,
        new Map(s.shapes.map((x) => [x.id, x.shapeHash])),
      ).missing,
    ).toEqual([]);
    expect(sourceSignatureOf(text, runs)).not.toEqual(
      sourceSignatureOf(`${text} `, runs),
    );
    const changed = structuredClone(runs);
    changed[0].points[1].lat += 0.001;
    expect(sourceSignatureOf(text, runs)).not.toEqual(
      sourceSignatureOf(text, changed),
    );
    expect(() => verifyShapeState(s, text, changed)).toThrow(
      "source run manifest mismatch",
    );
    expect(() => verifyShapeState(s, `${text} `, runs)).toThrow(
      "coverage hash mismatch",
    );
  });
  test("optional and extra drawable shapes still require exact positive hash validation", () => {
    const s = fixture();
    s.coverage.clauses[0].required = false;
    stamp(s);
    expect(normalApprovalBlockers(s, true, true, new Map()).missing).toContain(
      "shape",
    );
    expect(
      normalApprovalBlockers(
        s,
        true,
        true,
        new Map([[s.shapes[0].id, "wronghash"]]),
      ).missing,
    ).toContain("shape");
    const extra = {
      ...structuredClone(s.shapes[0]),
      id: randomUUID(),
      position: 1,
    };
    s.shapes.push(extra);
    stamp(s);
    expect(
      normalApprovalBlockers(
        s,
        true,
        true,
        new Map([[s.shapes[0].id, s.shapes[0].shapeHash]]),
      ).blockedShapeIds,
    ).toContain(extra.id);
  });
  test("human completeness confirmation cannot clear unsupported zero-point clauses or incomplete source", () => {
    const s = fixture();
    const blocked = {
      ...structuredClone(s.shapes[0]),
      id: randomUUID(),
      position: 1,
      sourceRunPositions: [],
      geojson: null,
      status: "blocked" as const,
      blockingReasons: ["unsupported_boundary" as const],
    };
    blocked.boundary = {
      ...blocked.boundary,
      mode: "unsupported",
      straightRuns: [],
    };
    s.shapes.push(blocked);
    s.coverage.clauses.push({
      id: randomUUID(),
      sourceSpan: { start: 0, end: text.length, quote: text },
      required: true,
      shapeIds: [blocked.id],
      issues: ["unsupported_boundary"],
    });
    stamp(s);
    expect(verifyShapeState(s, text, runs)).toEqual(s);
    expect(
      normalApprovalBlockers(
        s,
        true,
        true,
        new Map([[s.shapes[0].id, s.shapes[0].shapeHash]]),
      ).blockedShapeIds,
    ).toContain(blocked.id);
    s.coverage.sourceAvailability = "known_incomplete";
    stamp(s);
    expect(normalApprovalBlockers(s, true, true, new Map()).missing).toContain(
      "coverage",
    );
  });
  test("self-consistent hashes cannot disguise foreign spans/runs or unselected coastal output", () => {
    const s = fixture();
    s.shapes[0].boundary.sourceSpans[0].start = 1;
    stamp(s);
    expect(() => verifyShapeState(s, text, runs)).toThrow(
      "source span mismatch",
    );
    const coastal = fixture();
    coastal.shapes[0].boundary.mode = "lines-plus-coast";
    stamp(coastal);
    expect(() => verifyShapeState(coastal, text, runs)).toThrow(
      "incomplete coastal endpoint inventory",
    );
    coastal.shapes[0].requiredEndpoints = [
      { runPosition: 0, pointIndex: 0 },
      { runPosition: 0, pointIndex: 3 },
    ];
    stamp(coastal);
    expect(() => verifyShapeState(coastal, text, runs)).toThrow(
      "unselected coastal output",
    );
    const foreign = fixture();
    foreign.shapes[0].sourceRunPositions = [99];
    stamp(foreign);
    expect(() => verifyShapeState(foreign, text, runs)).toThrow(
      "foreign shape run",
    );
  });
});

test("immutable pin evidence covers the complete drawable set and exact manifest; metadata evidence cannot authorize drawing", () => {
  const state = fixture();
  const evidence: ApprovalEvidence = {
    version: 1,
    kind: "drawable",
    shapeManifestHash: state.shapeManifestHash,
    legalValidationId: randomUUID(),
    coverageValidationId: randomUUID(),
    coverageHash: state.coverage.coverageHash,
    shapes: state.shapes.map((s) => ({
      shapeId: s.id,
      shapeHash: s.shapeHash,
      validationId: randomUUID(),
    })),
  };
  expect(verifyApprovalEvidence(evidence, state, false)).toEqual(evidence);
  expect(() =>
    verifyApprovalEvidence({ ...evidence, shapes: [] }, state, false),
  ).toThrow();
  expect(() =>
    verifyApprovalEvidence(
      { ...evidence, shapeManifestHash: "a".repeat(64) },
      state,
      false,
    ),
  ).toThrow("identity mismatch");
  const metadata: ApprovalEvidence = {
    version: 1,
    kind: "metadata-only",
    shapeManifestHash: state.shapeManifestHash,
    legalValidationId: randomUUID(),
    acknowledgeUnresolvedGeometry: true,
    unresolvedGeometry: true,
  };
  expect(verifyApprovalEvidence(metadata, state, true)).toEqual(metadata);
  expect(() =>
    verifyApprovalEvidence(
      { ...metadata, acknowledgeUnresolvedGeometry: false },
      state,
      true,
    ),
  ).toThrow("acknowledgement missing");
  expect(
    verifyApprovalEvidence(
      {
        ...metadata,
        acknowledgeUnresolvedGeometry: false,
        unresolvedGeometry: false,
      },
      state,
      true,
    ),
  ).toEqual({
    ...metadata,
    acknowledgeUnresolvedGeometry: false,
    unresolvedGeometry: false,
  });
  expect(() => verifyApprovalEvidence(metadata, state, false)).toThrow(
    "identity mismatch",
  );
});
