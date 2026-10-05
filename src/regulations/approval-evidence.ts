import { z } from "zod";
import {
  type RevisionShapeState,
  normalApprovalBlockers,
} from "./coastal-state";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const approvalEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("drawable"),
      shapeManifestHash: hash,
      legalValidationId: uuid,
      coverageValidationId: uuid,
      coverageHash: hash,
      shapes: z
        .array(
          z
            .object({ shapeId: uuid, shapeHash: hash, validationId: uuid })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("metadata-only"),
      shapeManifestHash: hash,
      legalValidationId: uuid,
      acknowledgeUnresolvedGeometry: z.boolean(),
      unresolvedGeometry: z.boolean(),
    })
    .strict(),
]);
export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;
/** A pin keeps its approval-time receipt set. Reading a later negative
 * validation must not rewrite an already approved immutable shape. */
export function verifyApprovalEvidence(
  input: unknown,
  state: RevisionShapeState,
  metadataOnly: boolean,
): ApprovalEvidence {
  const evidence = approvalEvidenceSchema.parse(input);
  if (
    evidence.shapeManifestHash !== state.shapeManifestHash ||
    metadataOnly !== (evidence.kind === "metadata-only")
  )
    throw new Error("pin approval identity mismatch");
  if (evidence.kind === "drawable") {
    const drawable = state.shapes.filter((s) => s.geojson !== null);
    if (
      evidence.coverageHash !== state.coverage.coverageHash ||
      evidence.shapes.length !== drawable.length ||
      new Set(evidence.shapes.map((s) => s.shapeId)).size !==
        evidence.shapes.length ||
      new Set(evidence.shapes.map((s) => s.validationId)).size !==
        evidence.shapes.length ||
      evidence.shapes.some(
        (s, i) =>
          s.shapeId !== drawable[i].id || s.shapeHash !== drawable[i].shapeHash,
      )
    )
      throw new Error("pin validation manifest mismatch");
    const blockers = normalApprovalBlockers(
      state,
      true,
      true,
      new Map(evidence.shapes.map((s) => [s.shapeId, s.shapeHash])),
    );
    if (blockers.missing.length)
      throw new Error("pin contains unresolved or unvalidated shape");
  } else if (
    !evidence.acknowledgeUnresolvedGeometry &&
    evidence.unresolvedGeometry
  ) {
    // Completeness and shape receipts were intentionally not required for
    // metadata-only publication. Preserve the human's actual acknowledgement;
    // do not manufacture one merely because no geometry is served.
    throw new Error("pin unresolved geometry acknowledgement missing");
  }
  return evidence;
}
