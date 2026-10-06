import {
  canonicalDigest,
  canonicalJson,
  sha256Text,
} from "@/events/json-digest";
import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const index = z.number().int().nonnegative();
const finite = z.number().finite();
const position = z.tuple([finite.min(-180).max(180), finite.min(-90).max(90)]);
const ring = z
  .array(position)
  .min(4)
  .refine(
    (r) => r[0][0] === r.at(-1)?.[0] && r[0][1] === r.at(-1)?.[1],
    "ring must close exactly",
  );
const polygon = z.array(ring).min(1);
export const geoShapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: polygon }).strict(),
  z
    .object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(polygon).min(1),
    })
    .strict(),
]);
export type GeoShape = z.infer<typeof geoShapeSchema>;
export const sourceSpanSchema = z
  .object({ start: index, end: index, quote: z.string() })
  .strict()
  .refine((s) => s.end >= s.start);
export const endpointSchema = z
  .object({ runPosition: index, pointIndex: index })
  .strict();
export const shapeBlockSchema = z.enum([
  "unsupported_boundary",
  "ambiguous_source_group",
  "malformed_coordinate",
  "source_points_mismatch",
  "joins_unselected",
  "faces_unselected",
  "unresolved_endpoint_join",
  "ambiguous_endpoint_join",
  "invalid_topology",
  "empty_geometry",
  "outside_land_coverage",
  "land_dataset_unavailable",
  "resource_limit",
]);
export const coverageSchema = z
  .object({
    sourceSnapshotHash: hash,
    sourceAvailability: z.enum([
      "complete_snapshot",
      "missing",
      "known_incomplete",
    ]),
    clauses: z
      .array(
        z
          .object({
            id: uuid,
            sourceSpan: sourceSpanSchema,
            required: z.boolean(),
            shapeIds: z.array(uuid),
            issues: z.array(z.string()),
          })
          .strict(),
      )
      .max(512),
    coverageHash: hash,
  })
  .strict();
export const joinCandidateSchema = z
  .object({
    id: uuid,
    endpoint: endpointSchema,
    source: position,
    target: position,
    connector: z
      .object({
        type: z.literal("LineString"),
        coordinates: z.array(position).length(2),
      })
      .strict(),
    distanceMetres: finite.nonnegative(),
    landComponentId: z.string(),
    shorelineSegmentId: z.string(),
    landAreaM2WithinFrame: finite.nonnegative(),
    basis: z.string(),
  })
  .strict();
export const candidateFaceSchema = z
  .object({
    id: uuid,
    geojson: geoShapeSchema,
    areaM2: finite.nonnegative(),
    coordinateCount: index,
    holeCount: index,
  })
  .strict();
export const revisionShapeSchema = z
  .object({
    id: uuid,
    position: index,
    name: z.string().nullable(),
    section: z.string().nullable(),
    kind: z.enum(["closure", "exemption", "other"]),
    sourceRunPositions: z.array(index),
    boundary: z
      .object({
        mode: z.enum([
          "straight-ring",
          "ring-minus-land",
          "lines-plus-coast",
          "unsupported",
        ]),
        parserVersion: z.string(),
        sourceSpans: z.array(sourceSpanSchema),
        interpretation: z.string(),
        straightRuns: z.array(z.array(endpointSchema)),
        coastEdges: z.array(z.tuple([endpointSchema, endpointSchema])),
      })
      .strict(),
    status: z.enum(["blocked", "proposed"]),
    blockingReasons: z.array(shapeBlockSchema),
    geojson: geoShapeSchema.nullable(),
    shapeHash: hash,
    requiredEndpoints: z.array(endpointSchema),
    joinCandidates: z.array(joinCandidateSchema).max(64 * 2048),
    candidateEnumerationComplete: z.boolean(),
    selectedJoinCandidateIds: z.array(uuid),
    joinConfigurationHash: hash.nullable(),
    faceCandidates: z.array(candidateFaceSchema).max(64),
    faceEnumerationComplete: z.boolean(),
    selectedFaceIds: z.array(uuid),
    provenance: z
      .object({
        sourceSnapshotHash: hash,
        landDatasetId: z.string().nullable(),
        algorithmVersion: z.string(),
        engineVersions: z
          .object({ postgis: z.string(), geos: z.string(), proj: z.string() })
          .strict(),
        frame: z.tuple([finite, finite, finite, finite]).nullable(),
        parameters: z.record(z.union([finite, z.string(), z.boolean()])),
        justification: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export const revisionShapeStateSchema = z
  .object({
    geometryModelVersion: z.literal(1),
    coverage: coverageSchema,
    shapes: z.array(revisionShapeSchema).max(512),
    shapeManifestHash: hash,
  })
  .strict();
export type RevisionShape = z.infer<typeof revisionShapeSchema>;
export type RevisionShapeState = z.infer<typeof revisionShapeStateSchema>;
export type SourceRun = {
  position: number;
  points: Array<{ lat: number; lon: number }>;
};
export type SourceSignature = {
  sourceSnapshotHash: string;
  sourceRunManifestHash: string;
};
export function sourceSignatureOf(
  snapshotText: string | null,
  runs: SourceRun[],
): SourceSignature | null {
  if (snapshotText === null) return null;
  return {
    sourceSnapshotHash: sha256Text(snapshotText),
    sourceRunManifestHash: sourceRunManifestHashOf(runs),
  };
}
export function sourceRunManifestHashOf(runs: SourceRun[]): string {
  return canonicalDigest({
    version: 1,
    runs: [...runs]
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        position: r.position,
        points: r.points.map((p) => ({ lat: p.lat, lon: p.lon })),
      })),
  });
}
export function joinConfigurationDigest(shape: RevisionShape): string {
  return canonicalDigest({
    version: 1,
    shapeId: shape.id,
    boundary: shape.boundary,
    provenance: {
      sourceSnapshotHash: shape.provenance.sourceSnapshotHash,
      landDatasetId: shape.provenance.landDatasetId,
      algorithmVersion: shape.provenance.algorithmVersion,
      engineVersions: shape.provenance.engineVersions,
      frame: shape.provenance.frame,
      parameters: shape.provenance.parameters,
    },
    joins: shape.selectedJoinCandidateIds.map((id) =>
      shape.joinCandidates.find((c) => c.id === id),
    ),
  });
}
export function shapeDigest(
  shape: Omit<RevisionShape, "shapeHash"> | RevisionShape,
): string {
  const {
    shapeHash: _hash,
    shapeValidated: _validated,
    ...rest
  } = shape as RevisionShape & { shapeValidated?: boolean };
  return canonicalDigest(rest);
}
export function coverageDigest(
  coverage: RevisionShapeState["coverage"],
): string {
  const { coverageHash: _hash, ...rest } = coverage;
  return canonicalDigest(rest);
}
export function manifestDigest(
  state: Pick<
    RevisionShapeState,
    "geometryModelVersion" | "coverage" | "shapes"
  >,
): string {
  return canonicalDigest({
    geometryModelVersion: state.geometryModelVersion,
    coverageHash: state.coverage.coverageHash,
    shapes: state.shapes.map(({ id, shapeHash }) => ({ id, shapeHash })),
  });
}
const endpointKey = (e: z.infer<typeof endpointSchema>) =>
  `${e.runPosition}:${e.pointIndex}`;
function unique(values: Array<string | number>, what: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`duplicate ${what}`);
}
/** Hash and exact evidence integrity, independent of legal/admin decisions.
 * PostGIS validates final serialized topology separately before projection. */
export function verifyShapeState(
  input: unknown,
  snapshotText: string | null,
  runs: SourceRun[],
): RevisionShapeState {
  const state = revisionShapeStateSchema.parse(input);
  const actual = sha256Text(snapshotText ?? "");
  if (
    state.coverage.sourceSnapshotHash !== actual ||
    coverageDigest(state.coverage) !== state.coverage.coverageHash
  )
    throw new Error("coverage hash mismatch");
  if (snapshotText === null && state.coverage.sourceAvailability !== "missing")
    throw new Error("missing source cannot claim completeness");
  unique(
    state.shapes.map((s) => s.id),
    "shape id",
  );
  unique(
    state.shapes.map((s) => s.position),
    "shape position",
  );
  unique(
    state.coverage.clauses.map((c) => c.id),
    "clause id",
  );
  unique(
    runs.map((r) => r.position),
    "source run",
  );
  const runByPosition = new Map(runs.map((r) => [r.position, r]));
  const ids = new Set(state.shapes.map((s) => s.id));
  const span = (s: z.infer<typeof sourceSpanSchema>) => {
    if (
      s.end > (snapshotText ?? "").length ||
      (snapshotText ?? "").slice(s.start, s.end) !== s.quote
    )
      throw new Error("source span mismatch");
  };
  for (const clause of state.coverage.clauses) {
    span(clause.sourceSpan);
    unique(clause.shapeIds, "clause membership");
    if (clause.shapeIds.some((id) => !ids.has(id)))
      throw new Error("foreign clause shape");
  }
  for (const shape of state.shapes) {
    if (
      shape.provenance.parameters.sourceRunManifestHash !==
      sourceRunManifestHashOf(runs)
    )
      throw new Error("shape source run manifest mismatch");
    if (
      shape.shapeHash !== shapeDigest(shape) ||
      shape.provenance.sourceSnapshotHash !== actual
    )
      throw new Error("shape hash mismatch");
    unique(shape.sourceRunPositions, "shape run");
    if (shape.sourceRunPositions.some((p) => !runByPosition.has(p)))
      throw new Error("foreign shape run");
    for (const s of shape.boundary.sourceSpans) span(s);
    const endpoint = (e: z.infer<typeof endpointSchema>) => {
      const p = runByPosition.get(e.runPosition)?.points[e.pointIndex];
      if (!p || !shape.sourceRunPositions.includes(e.runPosition))
        throw new Error("foreign endpoint");
      return [p.lon, p.lat];
    };
    for (const run of shape.boundary.straightRuns)
      for (const e of run) endpoint(e);
    for (const edge of shape.boundary.coastEdges)
      for (const e of edge) endpoint(e);
    if (shape.boundary.mode === "lines-plus-coast") {
      const openEnds = new Set<string>();
      for (const run of shape.boundary.straightRuns) {
        if (run.length < 2) throw new Error("incomplete straight boundary run");
        openEnds.add(endpointKey(run[0]));
        openEnds.add(endpointKey(run[run.length - 1]));
      }
      const required = new Set(shape.requiredEndpoints.map(endpointKey));
      if (
        openEnds.size === 0 ||
        openEnds.size !== required.size ||
        [...openEnds].some((key) => !required.has(key))
      )
        throw new Error("incomplete coastal endpoint inventory");
    }
    unique(shape.requiredEndpoints.map(endpointKey), "required endpoint");
    for (const e of shape.requiredEndpoints) endpoint(e);
    unique(
      shape.joinCandidates.map((c) => c.id),
      "candidate id",
    );
    unique(
      shape.faceCandidates.map((c) => c.id),
      "face id",
    );
    unique(shape.selectedJoinCandidateIds, "selected join");
    unique(shape.selectedFaceIds, "selected face");
    const endpointCounts = new Map<string, number>();
    for (const c of shape.joinCandidates) {
      const raw = endpoint(c.endpoint);
      if (
        !shape.requiredEndpoints.some(
          (e) => endpointKey(e) === endpointKey(c.endpoint),
        ) ||
        canonicalJson(raw) !== canonicalJson(c.source) ||
        canonicalJson(c.connector.coordinates) !==
          canonicalJson([c.source, c.target])
      )
        throw new Error("candidate source endpoint mismatch");
      const key = endpointKey(c.endpoint);
      const count = (endpointCounts.get(key) ?? 0) + 1;
      endpointCounts.set(key, count);
      if (count > 64) throw new Error("candidate resource limit");
    }
    if (
      shape.selectedJoinCandidateIds.some(
        (id) => !shape.joinCandidates.some((c) => c.id === id),
      ) ||
      shape.selectedFaceIds.some(
        (id) => !shape.faceCandidates.some((c) => c.id === id),
      )
    )
      throw new Error("foreign selection");
    if (shape.selectedJoinCandidateIds.length > 0) {
      const selected = shape.selectedJoinCandidateIds.map((id) =>
        shape.joinCandidates.find((c) => c.id === id),
      );
      unique(
        selected.map((c) =>
          endpointKey(c?.endpoint ?? { runPosition: -1, pointIndex: -1 }),
        ),
        "selected endpoint",
      );
      if (
        !shape.candidateEnumerationComplete ||
        selected.length !== shape.requiredEndpoints.length ||
        shape.joinConfigurationHash !== joinConfigurationDigest(shape)
      )
        throw new Error("incomplete or stale join configuration");
    }
    if (
      shape.faceCandidates.length > 0 &&
      (shape.joinConfigurationHash === null || !shape.faceEnumerationComplete)
    )
      throw new Error("incomplete face configuration");
    if (
      shape.status === "proposed" &&
      shape.boundary.mode === "lines-plus-coast" &&
      (!shape.candidateEnumerationComplete ||
        shape.selectedJoinCandidateIds.length !==
          shape.requiredEndpoints.length ||
        shape.joinConfigurationHash === null ||
        !shape.faceEnumerationComplete ||
        shape.selectedFaceIds.length === 0)
    )
      throw new Error("unselected coastal output");
    if (
      shape.status === "proposed" &&
      (shape.geojson === null || shape.blockingReasons.length > 0)
    )
      throw new Error("blocked shape cannot be proposed");
  }
  if (manifestDigest(state) !== state.shapeManifestHash)
    throw new Error("shape manifest mismatch");
  return state;
}
export function normalApprovalBlockers(
  state: RevisionShapeState,
  legal: boolean,
  coverageValidated: boolean,
  shapeValidations: ReadonlyMap<string, string>,
): { missing: string[]; blockedShapeIds: string[] } {
  const missing: string[] = [];
  const blocked = new Set<string>();
  if (!legal) missing.push("legal");
  if (
    !coverageValidated ||
    state.coverage.sourceAvailability !== "complete_snapshot"
  )
    missing.push("coverage");
  if (!state.shapes.some((s) => s.geojson !== null)) missing.push("shape");
  const byId = new Map(state.shapes.map((s) => [s.id, s]));
  for (const clause of state.coverage.clauses.filter((c) => c.required)) {
    if (clause.shapeIds.length === 0 || clause.issues.length > 0)
      missing.push("shape");
    for (const id of clause.shapeIds) {
      const s = byId.get(id);
      if (
        !s ||
        s.status !== "proposed" ||
        s.geojson === null ||
        s.blockingReasons.length > 0
      ) {
        blocked.add(id);
        missing.push("shape");
      }
    }
  }
  for (const s of state.shapes) {
    if (
      s.geojson !== null &&
      (s.status !== "proposed" ||
        s.blockingReasons.length > 0 ||
        shapeValidations.get(s.id) !== s.shapeHash)
    ) {
      blocked.add(s.id);
      missing.push("shape");
    }
  }
  return { missing: [...new Set(missing)], blockedShapeIds: [...blocked] };
}
