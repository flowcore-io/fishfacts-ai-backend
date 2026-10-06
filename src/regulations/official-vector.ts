import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import type { RegulationRevisionGeometry } from "@/events/contracts";
import { canonicalDigest } from "@/events/json-digest";
import {
  type EvidenceRun,
  type OfficialVector,
  officialVectorSchema,
} from "@/events/official-vector";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deterministicUuid } from "./ids";
import type { SnapshotTx } from "./snapshot-assembler";

export class OfficialVectorRejectedError extends Error {}

export function officialSnapshotId(
  vector: Omit<OfficialVector, "snapshotId">,
): string {
  return canonicalDigest(vector);
}
export function verifyOfficialVector(value: unknown): OfficialVector {
  const vector = officialVectorSchema.parse(value);
  const { snapshotId, ...content } = vector;
  if (
    vector.geometryHash !== canonicalDigest(vector.geojson) ||
    vector.provenance.sourceVersion !== vector.geometryHash ||
    snapshotId !== officialSnapshotId(content)
  )
    throw new OfficialVectorRejectedError("official snapshot digest mismatch");
  return vector;
}
export async function storeOfficialVector(
  tx: SnapshotTx,
  caseId: string,
  value: unknown,
): Promise<OfficialVector> {
  const vector = verifyOfficialVector(value);
  await tx
    .insert(schema.regulationOfficialSnapshots)
    .values({ id: vector.snapshotId, caseId, payload: vector })
    .onConflictDoNothing();
  const [known] = await tx
    .select()
    .from(schema.regulationOfficialSnapshots)
    .where(eq(schema.regulationOfficialSnapshots.id, vector.snapshotId));
  if (
    !known ||
    known.caseId !== caseId ||
    canonicalDigest(known.payload) !== canonicalDigest(vector)
  )
    throw new OfficialVectorRejectedError(
      "conflicting immutable official snapshot",
    );
  const [valid] = await tx.execute(
    sql`with g as (select ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(vector.geojson)}),4326) geom) select ST_IsValid(geom) valid, ST_IsEmpty(geom) empty from g`,
  );
  if (!valid?.valid || valid.empty)
    throw new OfficialVectorRejectedError("invalid official polygon topology");
  return vector;
}

type StoredGeometry = {
  geometrySource: string;
  officialSnapshotId?: string | null;
  evidenceRuns?: unknown;
  paragraph?: number | null;
  caseId?: string;
};
/** Never expose a missing official binding as an ordinary points polygon. */
export async function hydrateOfficialGeometries<T extends StoredGeometry>(
  db: Pick<Database, "select">,
  rows: T[],
  caseId?: string,
) {
  const ids = [
    ...new Set(
      rows.flatMap((r) => (r.officialSnapshotId ? [r.officialSnapshotId] : [])),
    ),
  ];
  const snapshots = ids.length
    ? await db
        .select()
        .from(schema.regulationOfficialSnapshots)
        .where(
          and(
            inArray(schema.regulationOfficialSnapshots.id, ids),
            caseId
              ? eq(schema.regulationOfficialSnapshots.caseId, caseId)
              : undefined,
          ),
        )
    : [];
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  return rows.map((row) => {
    if (row.geometrySource !== "official-vector") return row;
    const stored = row.officialSnapshotId
      ? byId.get(row.officialSnapshotId)
      : undefined;
    if (row.officialSnapshotId && !stored)
      throw new Error("official snapshot missing or foreign");
    if (stored && row.caseId && stored.caseId !== row.caseId)
      throw new Error("official snapshot case binding mismatch");
    const vector = stored ? verifyOfficialVector(stored.payload) : null;
    if (vector && vector.provenance.paragraph !== row.paragraph)
      throw new Error("official section binding mismatch");
    return {
      ...row,
      points: [],
      geojson: vector?.geojson ?? null,
      snapshotId: vector?.snapshotId ?? null,
      geometryHash: vector?.geometryHash ?? null,
      provenance: vector?.provenance ?? null,
      evidenceRuns: (row.evidenceRuns ?? []) as EvidenceRun[],
      resolutionStatus: vector
        ? ("resolved" as const)
        : ("unresolved" as const),
      officialVector: vector,
    };
  });
}
export function proposalGeometry(
  row: RegulationRevisionGeometry & { officialVector?: OfficialVector | null },
): RegulationRevisionGeometry {
  return {
    name: row.name,
    section: row.section,
    kind: row.kind,
    season: row.season,
    verticesQuoted: row.verticesQuoted,
    points: row.points,
    geometrySource: row.geometrySource,
    coordinateSystem: row.coordinateSystem,
    precision: row.precision,
    ...(row.geometrySource === "official-vector"
      ? {
          paragraph: row.paragraph ?? null,
          officialVector: row.officialVector ?? null,
          evidenceRuns: row.evidenceRuns ?? [],
        }
      : {}),
  };
}
export function snapshotManifestHash(
  geometries: Array<{
    id: string;
    snapshotId?: string | null;
    geometryHash?: string | null;
    geometrySource: string;
  }>,
): string | null {
  const official = geometries.filter(
    (g) => g.geometrySource === "official-vector",
  );
  return official.length
    ? canonicalDigest(
        official.map((g) => ({
          id: g.id,
          snapshotId: g.snapshotId ?? null,
          geometryHash: g.geometryHash ?? null,
        })),
      )
    : null;
}
export function evidenceId(sourceContentHash: string, position: number) {
  return deterministicUuid(
    "regulation-printed-evidence",
    `${sourceContentHash}:${position}`,
  );
}

/** Compact identity query for source-index redirects; never pulls polygon
 * coordinates into a paginated list just to identify its approved payload. */
export async function pinnedSnapshotManifests(
  db: Pick<Database, "select">,
  revisionIds: string[],
): Promise<Map<string, string>> {
  if (!revisionIds.length) return new Map();
  const rows = await db
    .select({
      id: schema.regulationCaseGeometries.id,
      revisionId: schema.regulationCaseGeometries.revisionId,
      snapshotId: schema.regulationCaseGeometries.officialSnapshotId,
      geometryHash: sql<
        string | null
      >`${schema.regulationOfficialSnapshots.payload}->>'geometryHash'`,
    })
    .from(schema.regulationCaseGeometries)
    .leftJoin(
      schema.regulationOfficialSnapshots,
      and(
        eq(
          schema.regulationOfficialSnapshots.id,
          schema.regulationCaseGeometries.officialSnapshotId,
        ),
        eq(
          schema.regulationOfficialSnapshots.caseId,
          schema.regulationCaseGeometries.caseId,
        ),
      ),
    )
    .where(
      and(
        inArray(schema.regulationCaseGeometries.revisionId, revisionIds),
        eq(schema.regulationCaseGeometries.geometrySource, "official-vector"),
      ),
    )
    .orderBy(schema.regulationCaseGeometries.position);
  const grouped = new Map<
    string,
    Array<{
      id: string;
      snapshotId: string | null;
      geometryHash: string | null;
    }>
  >();
  for (const { revisionId, ...row } of rows) {
    const group = grouped.get(revisionId) ?? [];
    group.push(row);
    grouped.set(revisionId, group);
  }
  return new Map([...grouped].map(([id, rows]) => [id, canonicalDigest(rows)]));
}
