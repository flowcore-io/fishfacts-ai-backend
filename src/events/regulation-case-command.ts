import { z } from "zod";
import { REGULATION_FLOW_TYPE } from "./contracts";
import { snapshotPartSchema } from "./regulation-snapshot-parts";

export const CASE_COMMAND_PART_EVENT_TYPE = "regulation.case.command.part.1";
export const CASE_COMMAND_PART_PATHWAY = `${REGULATION_FLOW_TYPE}/${CASE_COMMAND_PART_EVENT_TYPE}`;
export const commandOperationSchema = z.enum([
  "source",
  "proposal",
  "pointer",
  "validation",
  "coverage-validation",
  "approval",
  "revoke",
  "verdict",
  "request",
]);
export const caseCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: z.string().uuid(),
    caseId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    predecessorCommandId: z.string().uuid().nullable(),
    baseRevisionId: z.string().uuid(),
    revisionId: z.string().uuid(),
    operation: commandOperationSchema,
    actor: z.string().min(1),
    recordedAt: z.string().datetime(),
    data: z.unknown(),
  })
  .strict();
export type CaseCommand = z.infer<typeof caseCommandSchema>;
export type CaseCommandInput = Pick<
  CaseCommand,
  | "commandId"
  | "caseId"
  | "baseRevisionId"
  | "revisionId"
  | "operation"
  | "actor"
  | "data"
>;
/** Ordering identity is exposed on EVERY byte part, so incomplete replay
 * can fence delivery allocation even before its body can be assembled. */
export const commandPartSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    predecessorCommandId: z.string().uuid().nullable(),
    part: snapshotPartSchema,
  })
  .strict();
export type CommandPart = z.infer<typeof commandPartSchema>;
