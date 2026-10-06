import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const coordinate = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const ring = z
  .array(coordinate)
  .min(4)
  .superRefine((points, ctx) => {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1])
      ctx.addIssue({ code: "custom", message: "polygon ring is not closed" });
  });
const polygon = z.array(ring).min(1);
export const officialGeojsonSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("Polygon"), coordinates: polygon }).strict(),
    z
      .object({
        type: z.literal("MultiPolygon"),
        coordinates: z.array(polygon).min(1),
      })
      .strict(),
  ])
  .superRefine((geometry, ctx) => {
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    if (
      polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0) >
      200_000
    )
      ctx.addIssue({
        code: "custom",
        message: "official geometry coordinate resource limit",
      });
  });
export const officialVectorSchema = z
  .object({
    snapshotId: digest,
    geometryHash: digest,
    geojson: officialGeojsonSchema,
    provenance: z
      .object({
        source: z.literal("fiskeridir-wfs"),
        sourceUrl: z.literal(
          "https://gis.fiskeridir.no/server/rest/services/J_melding_stengt_wfs/MapServer/0/query",
        ),
        sourceRef: z.string().regex(/^j-\d+-\d{4}$/i),
        paragraph: z.number().int().positive(),
        sourceContentHash: digest,
        // The provider has no revision token: this is the observed geometry digest.
        sourceVersion: digest,
        fetchedAt: z.string().datetime(),
        featureIds: z.array(z.string().min(1).max(100)).max(1000),
        attribution: z.literal("Fiskeridirektoratet · NLOD"),
      })
      .strict(),
  })
  .strict();
export const evidenceRunSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  name: z.string().max(300).nullable(),
  section: z.string().max(200).nullable(),
  points: z
    .array(
      z.object({
        lat: z.number().finite().min(-90).max(90),
        lon: z.number().finite().min(-180).max(180),
      }),
    )
    .min(1),
  verticesQuoted: z.array(z.string().max(200)).nullable(),
});
export type OfficialVector = z.infer<typeof officialVectorSchema>;
export type EvidenceRun = z.infer<typeof evidenceRunSchema>;
