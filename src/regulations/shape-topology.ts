import { sql } from "drizzle-orm";
import type { RevisionShapeState } from "./coastal-state";
import { ShapeCommandRejectedError } from "./shape-rejection";
import type { SnapshotTx } from "./snapshot-assembler";
/** Validate the FINAL serialized JavaScript GeoJSON, including every ring and
 * piece. No AsGeoJSON precision reduction, repair, buffer or simplification. */
export async function validateShapeTopology(
  tx: SnapshotTx,
  state: RevisionShapeState,
): Promise<void> {
  const previews = state.shapes.flatMap((s) => [
    ...(s.geojson ? [s.geojson] : []),
    ...s.faceCandidates.map((f) => f.geojson),
  ]);
  for (const geometry of previews) {
    let count = 0;
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    for (const polygon of polygons)
      for (const ring of polygon) count += ring.length;
    if (count > 200_000)
      throw new ShapeCommandRejectedError("shape coordinate resource limit");
    const result = await tx.execute(
      sql`with g as (select ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}),4326) geom) select ST_IsValid(geom) valid,ST_IsEmpty(geom) empty,ST_IsValidReason(geom) reason from g`,
    );
    const row = result[0] as
      | { valid: boolean; empty: boolean; reason: string }
      | undefined;
    if (!row || !row.valid || row.empty)
      throw new ShapeCommandRejectedError(
        `invalid serialized shape topology: ${row?.reason ?? "missing"}`,
      );
  }
}
