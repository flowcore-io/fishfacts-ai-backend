import { z } from "zod";
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = { requestId: uuid, baseRevisionId: uuid };
export const reconstructionStartSchema = z
  .object({ ...base, landDatasetId: z.string().min(1).max(200) })
  .strict();
export const reconstructionJoinsSchema = z
  .object({
    ...base,
    shapeId: uuid,
    shapeHash: hash,
    joinCandidateIds: z.array(uuid).min(1).max(1024),
    justification: z.string().min(1).max(2000),
  })
  .strict();
export const reconstructionFacesSchema = z
  .object({
    ...base,
    shapeId: uuid,
    shapeHash: hash,
    joinConfigurationHash: hash,
    faceIds: z.array(uuid).min(1).max(64),
    justification: z.string().min(1).max(2000),
  })
  .strict();
export const reconstructionIntentSchema = z.discriminatedUnion("kind", [
  reconstructionStartSchema.extend({ kind: z.literal("start") }),
  reconstructionJoinsSchema.extend({ kind: z.literal("joins") }),
  reconstructionFacesSchema.extend({ kind: z.literal("faces") }),
]);
export type ReconstructionIntent = z.infer<typeof reconstructionIntentSchema>;
export const reconstructionFailureSchema = z
  .object({
    requestId: uuid,
    error: z.string().min(1).max(100),
    reason: z.string().max(2000).optional(),
  })
  .strict();
