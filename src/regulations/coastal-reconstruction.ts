import { canonicalDigest } from "@/events/json-digest";
import type postgres from "postgres";
import {
  type GeoShape,
  type RevisionShape,
  type RevisionShapeState,
  type SourceRun,
  geoShapeSchema,
  joinConfigurationDigest,
  manifestDigest,
  shapeDigest,
  verifyShapeState,
} from "./coastal-state";
import { revisionIdFor } from "./ids";
import { verifyLandManifest } from "./land-dataset";
import { withinOriginalSegmentStrip } from "./shoreline-witness";

type Point = [number, number];
type Block = RevisionShape["blockingReasons"][number];
export class ReconstructionBlocked extends Error {
  constructor(readonly reason: Block) {
    super(reason);
  }
}
function endpoint(
  runs: SourceRun[],
  ref: { runPosition: number; pointIndex: number },
): Point {
  const p = runs.find((r) => r.position === ref.runPosition)?.points[
    ref.pointIndex
  ];
  if (!p) throw Error("source endpoint not in exact run");
  return [p.lon, p.lat];
}
function frameOf(
  shape: RevisionShape,
  runs: SourceRun[],
): [number, number, number, number] {
  const points = shape.sourceRunPositions.flatMap(
    (position) => runs.find((r) => r.position === position)?.points ?? [],
  );
  if (!points.length) throw new ReconstructionBlocked("source_points_mismatch");
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  return [
    Math.min(...lons) - 1.5,
    Math.min(...lats) - 1.5,
    Math.max(...lons) + 1.5,
    Math.max(...lats) + 1.5,
  ];
}
async function landFrame(
  tx: postgres.TransactionSql,
  datasetId: string,
  frame: [number, number, number, number],
) {
  await tx`SET LOCAL statement_timeout='45000ms'`;
  const dataset =
    await tx`SELECT manifest,ST_Covers(coverage,ST_MakeEnvelope(${frame[0]},${frame[1]},${frame[2]},${frame[3]},4326)) covered FROM regulation_land_datasets WHERE id=${datasetId}`;
  if (!dataset.length)
    throw new ReconstructionBlocked("land_dataset_unavailable");
  verifyLandManifest(dataset[0].manifest);
  if (dataset[0].covered !== true)
    throw new ReconstructionBlocked("outside_land_coverage");
  const bound =
    await tx`SELECT coalesce(sum(ST_NPoints(ST_Intersection(geom,ST_MakeEnvelope(${frame[0]},${frame[1]},${frame[2]},${frame[3]},4326)))),0)::bigint count FROM regulation_land_features WHERE dataset_id=${datasetId} AND geom && ST_MakeEnvelope(${frame[0]},${frame[1]},${frame[2]},${frame[3]},4326)`;
  if (Number(bound[0].count) > 500_000)
    throw new ReconstructionBlocked("resource_limit");
  await tx`CREATE TEMP TABLE coastal_request_land ON COMMIT DROP AS SELECT ST_UnaryUnion(ST_Collect(ST_Intersection(geom,ST_MakeEnvelope(${frame[0]},${frame[1]},${frame[2]},${frame[3]},4326)))) geom FROM regulation_land_features WHERE dataset_id=${datasetId} AND geom && ST_MakeEnvelope(${frame[0]},${frame[1]},${frame[2]},${frame[3]},4326)`;
  await tx`CREATE TEMP TABLE coastal_request_components ON COMMIT DROP AS SELECT d.path component_path,d.geom,ST_Area(ST_Transform(d.geom,25833)) area FROM coastal_request_land,LATERAL ST_Dump(geom) d`;
  await tx`CREATE TEMP TABLE coastal_request_shore ON COMMIT DROP AS SELECT r.component_path,p.path ring_path,p.geom FROM coastal_request_components r,LATERAL ST_DumpRings(r.geom) p`;
  return (
    await tx`SELECT PostGIS_Lib_Version() postgis,PostGIS_GEOS_Version() geos,PostGIS_PROJ_Version() proj`
  )[0] as { postgis: string; geos: string; proj: string };
}
function finish(
  state: RevisionShapeState,
  text: string | null,
  runs: SourceRun[],
) {
  for (const s of state.shapes) s.shapeHash = shapeDigest(s);
  state.shapeManifestHash = manifestDigest(state);
  return verifyShapeState(state, text, runs);
}
/** Geometry is live bounded request work only. This class never projects events,
 * writes domain state, loads authority polygons or chooses joins/faces for users. */
export class CoastalReconstruction {
  constructor(private readonly sql: postgres.Sql) {}
  async propose(
    input: RevisionShapeState,
    text: string | null,
    runs: SourceRun[],
    datasetId: string,
  ) {
    const state = structuredClone(verifyShapeState(input, text, runs));
    for (const shape of state.shapes) {
      shape.provenance.landDatasetId = datasetId;
      shape.provenance.algorithmVersion = "existing-shore-node-polygonize/1";
      if (shape.boundary.mode !== "lines-plus-coast") continue;
      shape.provenance.frame = frameOf(shape, runs);
      try {
        await this.sql.begin(async (tx) => {
          shape.provenance.engineVersions = await landFrame(
            tx,
            datasetId,
            shape.provenance.frame as [number, number, number, number],
          );
          shape.provenance.parameters = {
            ...shape.provenance.parameters,
            joinRadiusMetres: 3000,
            frameMarginDegrees: 1.5,
            candidatePolicy:
              "one nearest existing shoreline node per connected clipped land component; all components within radius",
            derivedLineworkOperation:
              "union and frame clipping of versioned land; unchanged component/ring shoreline nodes; no insertion, snap, buffer or precision reduction",
          };
          shape.joinCandidates = [];
          for (const ref of shape.requiredEndpoints) {
            const source = endpoint(runs, ref);
            const alternatives =
              await tx`WITH candidates AS (SELECT c.component_path,c.area,encode(ST_AsBinary(c.geom,'NDR'),'hex') component_wkb,p.path vertex_path,p.geom target FROM coastal_request_components c CROSS JOIN LATERAL (SELECT q.path,q.geom FROM ST_DumpPoints(ST_Boundary(c.geom)) q WHERE NOT ST_Intersects(q.geom,ST_Boundary(ST_MakeEnvelope(${(shape.provenance.frame as [number, number, number, number])[0]},${(shape.provenance.frame as [number, number, number, number])[1]},${(shape.provenance.frame as [number, number, number, number])[2]},${(shape.provenance.frame as [number, number, number, number])[3]},4326))) ORDER BY ST_Distance(q.geom::geography,ST_SetSRID(ST_MakePoint(${source[0]},${source[1]}),4326)::geography),q.path LIMIT 1) p), distances AS (SELECT *,ST_Distance(target::geography,ST_SetSRID(ST_MakePoint(${source[0]},${source[1]}),4326)::geography) distance FROM candidates) SELECT component_path,area,component_wkb,vertex_path,distance,ST_AsGeoJSON(target,17)::json target FROM distances WHERE distance<=3000 ORDER BY distance,component_path LIMIT 65`;
            if (alternatives.length > 64)
              throw new ReconstructionBlocked("resource_limit");
            if (!alternatives.length)
              throw new ReconstructionBlocked("unresolved_endpoint_join");
            for (const a of alternatives) {
              const componentId = canonicalDigest({
                version: 1,
                datasetId,
                frame: shape.provenance.frame,
                path: a.component_path,
                wkb: a.component_wkb,
              });
              const target = a.target.coordinates as Point;
              const segmentId = `${componentId}:${a.vertex_path.join(".")}`;
              const candidate = {
                id: revisionIdFor(
                  `join:${shape.id}:${ref.runPosition}:${ref.pointIndex}:${segmentId}`,
                ),
                endpoint: ref,
                source,
                target,
                connector: {
                  type: "LineString" as const,
                  coordinates: [source, target],
                },
                distanceMetres: Number(a.distance),
                landComponentId: componentId,
                shorelineSegmentId: segmentId,
                landAreaM2WithinFrame: Number(a.area),
                basis:
                  "Existing exact shoreline node; component/ring/vertex path fixed to this dataset and frame. Explicit human selection required.",
              };
              shape.joinCandidates.push(candidate);
            }
          }
          shape.candidateEnumerationComplete = true;
          shape.blockingReasons = ["joins_unselected"];
        });
      } catch (error) {
        if (!(error instanceof ReconstructionBlocked)) throw error;
        shape.joinCandidates = [];
        shape.candidateEnumerationComplete = false;
        shape.blockingReasons = [error.reason];
      }
    }
    return finish(state, text, runs);
  }
  async selectJoins(
    input: RevisionShapeState,
    text: string | null,
    runs: SourceRun[],
    shapeId: string,
    shapeHash: string,
    ids: string[],
    justification: string,
  ) {
    const state = structuredClone(verifyShapeState(input, text, runs));
    const shape = state.shapes.find((s) => s.id === shapeId);
    if (!shape || shape.shapeHash !== shapeHash)
      throw Error("shape identity mismatch");
    if (
      !shape.candidateEnumerationComplete ||
      shape.boundary.mode !== "lines-plus-coast"
    )
      throw Error("join candidates incomplete");
    const choices = ids.map((id) =>
      shape.joinCandidates.find((c) => c.id === id),
    );
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      choices.some((c) => !c) ||
      choices.length !== shape.requiredEndpoints.length
    )
      throw Error("foreign/duplicate/missing required joins");
    const selectedEndpoints = choices.map(
      (c) => `${c?.endpoint.runPosition}:${c?.endpoint.pointIndex}`,
    );
    if (
      new Set(selectedEndpoints).size !== selectedEndpoints.length ||
      shape.requiredEndpoints.some(
        (e) => !selectedEndpoints.includes(`${e.runPosition}:${e.pointIndex}`),
      )
    )
      throw Error("missing required endpoint");
    if (!shape.provenance.landDatasetId || !shape.provenance.frame)
      throw Error("missing join provenance");
    shape.selectedJoinCandidateIds = ids;
    shape.provenance.justification = justification;
    shape.joinConfigurationHash = joinConfigurationDigest(shape);
    shape.faceCandidates = [];
    shape.selectedFaceIds = [];
    shape.faceEnumerationComplete = false;
    shape.geojson = null;
    shape.status = "blocked";
    shape.blockingReasons = ["faces_unselected"];
    try {
      await this.sql.begin(async (tx) => {
        await landFrame(
          tx,
          shape.provenance.landDatasetId as string,
          shape.provenance.frame as [number, number, number, number],
        );
        const straight = {
          type: "MultiLineString",
          coordinates: shape.boundary.straightRuns.map((r) =>
            r.map((e) => endpoint(runs, e)),
          ),
        };
        const linework = {
          type: "MultiLineString",
          coordinates: [
            ...straight.coordinates,
            ...choices.map((c) => c?.connector.coordinates),
          ],
        };
        await tx`CREATE TEMP TABLE coastal_request_faces ON COMMIT DROP AS WITH coast AS (SELECT ST_Collect(ST_Boundary(geom)) geom FROM coastal_request_land),lines AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(linework)}::text),4326) geom),nodes AS (SELECT ST_Node(ST_CollectionExtract(ST_Collect(coast.geom,lines.geom),2)) geom FROM coast,lines),faces AS (SELECT (ST_Dump(ST_Polygonize(ARRAY[geom]))).geom FROM nodes) SELECT f.geom FROM faces f,coastal_request_land land,lines WHERE ST_Intersects(ST_Boundary(f.geom),lines.geom) AND NOT ST_Covers(land.geom,ST_PointOnSurface(f.geom)) AND NOT ST_Intersects(f.geom,ST_Boundary(ST_MakeEnvelope(${(shape.provenance.frame as [number, number, number, number])[0]},${(shape.provenance.frame as [number, number, number, number])[1]},${(shape.provenance.frame as [number, number, number, number])[2]},${(shape.provenance.frame as [number, number, number, number])[3]},4326))) AND ST_Intersects(ST_Boundary(f.geom),ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(straight)}::text),4326))`;
        const [previewBound] =
          await tx`SELECT count(*)::int count,coalesce(sum(ST_NPoints(geom)),0)::bigint coordinates FROM coastal_request_faces`;
        if (
          Number(previewBound.count) > 64 ||
          Number(previewBound.coordinates) > 200_000
        )
          throw new ReconstructionBlocked("resource_limit");
        const faces =
          await tx`SELECT ST_AsGeoJSON(geom,17)::json geojson,ST_IsValid(geom) valid,ST_NPoints(geom) count,ST_NumInteriorRings(geom) holes,ST_Area(ST_Transform(geom,25833)) area FROM coastal_request_faces ORDER BY encode(ST_AsBinary(geom,'NDR'),'hex') LIMIT 65`;
        if (faces.length > 64)
          throw new ReconstructionBlocked("resource_limit");
        if (!faces.length) throw new ReconstructionBlocked("empty_geometry");
        const witnesses: unknown[] = [];
        for (const face of faces) {
          if (!face.valid) throw new ReconstructionBlocked("invalid_topology");
          if (Number(face.count) > 200_000)
            throw new ReconstructionBlocked("resource_limit");
          const geometry = geoShapeSchema.parse(face.geojson);
          witnesses.push(...(await wholeLandExclusion(tx, geometry)));
          shape.faceCandidates.push({
            id: revisionIdFor(
              `face:${shape.joinConfigurationHash}:${canonicalDigest(geometry)}`,
            ),
            geojson: geometry,
            areaM2: Number(face.area),
            coordinateCount: Number(face.count),
            holeCount: Number(face.holes),
          });
        }
        shape.provenance.parameters.wholeLandOverlapWitnesses =
          JSON.stringify(witnesses);
        // Witnesses are part of provenance and therefore join identity too.
        shape.joinConfigurationHash = joinConfigurationDigest(shape);
        shape.faceCandidates = shape.faceCandidates.map((f) => ({
          ...f,
          id: revisionIdFor(
            `face:${shape.joinConfigurationHash}:${canonicalDigest(f.geojson)}`,
          ),
        }));
        shape.faceEnumerationComplete = true;
      });
    } catch (error) {
      if (!(error instanceof ReconstructionBlocked)) throw error;
      shape.faceCandidates = [];
      shape.faceEnumerationComplete = false;
      shape.blockingReasons = [error.reason];
    }
    return finish(state, text, runs);
  }
  async selectFaces(
    input: RevisionShapeState,
    text: string | null,
    runs: SourceRun[],
    shapeId: string,
    shapeHash: string,
    configuration: string,
    ids: string[],
    justification: string,
  ) {
    const state = structuredClone(verifyShapeState(input, text, runs));
    const shape = state.shapes.find((s) => s.id === shapeId);
    if (
      !shape ||
      shape.shapeHash !== shapeHash ||
      shape.joinConfigurationHash !== configuration
    )
      throw Error("stale shape/join configuration");
    const choices = ids.map((id) =>
      shape.faceCandidates.find((f) => f.id === id),
    );
    if (
      !shape.faceEnumerationComplete ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      choices.some((f) => !f)
    )
      throw Error("foreign/duplicate/missing faces");
    const geometries = choices.map((f) => f?.geojson);
    const result = await this
      .sql`SELECT ST_AsGeoJSON(ST_Multi(ST_UnaryUnion(ST_Collect(ST_SetSRID(ST_GeomFromGeoJSON(v::text),4326)))),17)::json geometry FROM json_array_elements(${JSON.stringify(geometries)}::text::json) v`;
    shape.geojson = geoShapeSchema.parse(result[0].geometry);
    shape.selectedFaceIds = ids;
    shape.status = "proposed";
    shape.blockingReasons = [];
    shape.provenance.justification = justification;
    // Final serialized JSON is revalidated, never rounded/simplified to fit.
    const valid = await this
      .sql`SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(shape.geojson)}::text),4326)) valid`;
    if (!valid[0].valid) throw new ReconstructionBlocked("invalid_topology");
    return finish(state, text, runs);
  }
}
async function wholeLandExclusion(
  tx: postgres.TransactionSql,
  geometry: GeoShape,
) {
  const leaks =
    await tx`WITH overlap AS (SELECT ST_CollectionExtract(ST_Intersection(geom,ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}::text),4326)),3) geom FROM coastal_request_land) SELECT ST_AsGeoJSON(d.geom,17)::json geometry,ST_NPoints(d.geom) count FROM overlap,LATERAL ST_Dump(geom) d WHERE NOT ST_IsEmpty(d.geom) LIMIT 65`;
  if (leaks.length > 64) throw new ReconstructionBlocked("resource_limit");
  const witnesses: unknown[] = [];
  for (const leak of leaks) {
    if (Number(leak.count) > 1024)
      throw new ReconstructionBlocked("invalid_topology");
    const geo = geoShapeSchema.parse(leak.geometry);
    const polygons =
      geo.type === "Polygon" ? [geo.coordinates] : geo.coordinates;
    const points = polygons.flatMap((p) => p.flat()) as Point[];
    const segments =
      await tx`SELECT s.path,ST_AsGeoJSON(s.geom,17)::json geometry FROM coastal_request_land,LATERAL ST_DumpSegments(ST_Boundary(geom)) s WHERE s.geom && ST_Expand(ST_Envelope(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geo)}::text),4326)),1e-12) LIMIT 65`;
    if (segments.length > 64) throw new ReconstructionBlocked("resource_limit");
    const witness = segments.find((s) =>
      withinOriginalSegmentStrip(points, s.geometry.coordinates),
    );
    if (!witness) throw new ReconstructionBlocked("invalid_topology");
    witnesses.push({
      originalSegmentPath: witness.path,
      originalSegment: witness.geometry,
      wholeOverlap: geo,
      boundDegrees: 1e-12,
      boundMetresUpper: 1.12e-7,
      basis:
        "Exact rational binary64 predicates bind every vertex/whole polygon to ONE unchanged shoreline segment strip; no output edits or area filtering",
    });
  }
  return witnesses;
}
