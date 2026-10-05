import { z } from "zod";
import { REGULATION_FLOW_TYPE } from "./contracts";
export const SOURCE_OBSERVATION_BARRIER_EVENT_TYPE =
  "regulation.source.observations.barrier.1";
export const CASE_COMMAND_BARRIER_EVENT_TYPE =
  "regulation.case.command.barrier.1";
export const CASE_COMMAND_BARRIER_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${CASE_COMMAND_BARRIER_EVENT_TYPE}` as const;
export const commandBarrierSchema = z
  .object({ barrierId: z.string().uuid(), recordedAt: z.string().datetime() })
  .strict();
