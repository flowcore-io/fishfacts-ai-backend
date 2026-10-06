import { revisionShapeStateSchema } from "@/regulations/coastal-state";
import { z } from "zod";
import {
  jmeldingAnnouncementDiscoveredSchema,
  regulationAdminActionSchema,
  regulationRevisionChangeSchema,
  regulationRevisionFieldsSchema,
  regulationRevisionGeometrySchema,
  regulationVerdictRecordedSchema,
} from "./contracts";
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const modeledProposalSchema = z
  .object({
    reconstructionRequestId: uuid.optional(),
    fields: regulationRevisionFieldsSchema,
    geometries: z
      .array(
        regulationRevisionGeometrySchema.extend({
          position: z.number().int().nonnegative(),
        }),
      )
      .max(512),
    shapeState: revisionShapeStateSchema,
    changes: z.array(regulationRevisionChangeSchema).min(1),
    snapshot: z
      .object({
        text: z.string().nullable(),
        url: z.string().min(1),
        fetchedAt: z.string().datetime().nullable(),
        fragmentId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
const decisionBase = {
  validationId: uuid,
  validated: z.boolean(),
  note: z.string().max(2000).nullable(),
};
export const modeledValidationSchema = z.discriminatedUnion("scope", [
  z.object({ ...decisionBase, scope: z.literal("legal") }).strict(),
  z
    .object({
      ...decisionBase,
      scope: z.literal("shape"),
      shapeId: uuid,
      shapeHash: hash,
    })
    .strict(),
  z
    .object({
      ...decisionBase,
      scope: z.literal("coverage"),
      coverageHash: hash,
    })
    .strict(),
]);
export const modeledApprovalSchema = z
  .object({
    approvalId: uuid,
    shapeManifestHash: hash,
    metadataOnly: z.boolean(),
    acknowledgeUnresolvedGeometry: z.boolean().default(false),
    note: z.string().max(2000).nullable(),
  })
  .strict();
export const modeledPointerSchema = z
  .object({ pointerMoveId: uuid, toRevisionId: uuid })
  .strict();
export const modeledRevokeSchema = z
  .object({ actionId: uuid, action: regulationAdminActionSchema })
  .strict();
export const modeledSourceSchema = z
  .object({ inputId: uuid, item: jmeldingAnnouncementDiscoveredSchema })
  .strict();
export const modeledVerdictSchema = regulationVerdictRecordedSchema;
