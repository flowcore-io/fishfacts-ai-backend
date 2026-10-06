import * as schema from "@/db/schema";
import { canonicalDigest } from "@/events/json-digest";
import {
  reconstructionFailureSchema,
  reconstructionIntentSchema,
} from "@/events/reconstruction-request";
import type { CaseCommand } from "@/events/regulation-case-command";
import { and, eq } from "drizzle-orm";
import { revisionIdFor } from "./ids";
import type { SnapshotApplication, SnapshotTx } from "./snapshot-assembler";
export const reconstructionIds = (requestId: string) => ({
  revisionId: revisionIdFor(`reconstruction-revision:${requestId}`),
  resultCommandId: revisionIdFor(`reconstruction-result:${requestId}`),
  failureCommandId: revisionIdFor(`reconstruction-failure:${requestId}`),
});
export async function projectReconstructionIntent(
  tx: SnapshotTx,
  c: CaseCommand,
  currentRevisionId: string,
): Promise<SnapshotApplication> {
  const parsed = reconstructionIntentSchema.safeParse(c.data);
  if (
    !parsed.success ||
    parsed.data.requestId !== c.commandId ||
    parsed.data.baseRevisionId !== c.baseRevisionId ||
    c.revisionId !== reconstructionIds(c.commandId).revisionId ||
    !c.actor.startsWith("admin:")
  )
    return {
      status: "refused",
      reason: "invalid reconstruction intent identity",
    };
  const [known] = await tx
    .select()
    .from(schema.regulationReconstructionRequests)
    .where(eq(schema.regulationReconstructionRequests.id, c.commandId));
  const inputHash = canonicalDigest({
    intent: parsed.data,
    actor: c.actor,
    caseId: c.caseId,
  });
  if (known)
    return {
      status: "refused",
      reason: "immutable reconstruction request already exists",
    };
  const stale = currentRevisionId !== c.baseRevisionId;
  await tx.insert(schema.regulationReconstructionRequests).values({
    id: c.commandId,
    caseId: c.caseId,
    baseRevisionId: c.baseRevisionId,
    revisionId: c.revisionId,
    actor: c.actor,
    inputHash,
    intent: parsed.data,
    recordedAt: new Date(c.recordedAt),
    status: stale ? "failed" : "pending",
    error: stale ? { error: "stale_revision" } : null,
  });
  return stale
    ? { status: "refused", reason: "stale reconstruction base" }
    : { status: "applied" };
}
export async function reconstructionParent(
  tx: SnapshotTx,
  c: CaseCommand,
  requestId: string,
) {
  const [parent] = await tx
    .select()
    .from(schema.regulationReconstructionRequests)
    .where(
      and(
        eq(schema.regulationReconstructionRequests.id, requestId),
        eq(schema.regulationReconstructionRequests.caseId, c.caseId),
      ),
    );
  const ids = reconstructionIds(requestId);
  if (
    !parent ||
    parent.actor !== c.actor ||
    parent.baseRevisionId !== c.baseRevisionId ||
    parent.revisionId !== c.revisionId ||
    c.commandId !== ids.resultCommandId ||
    parent.status !== "pending"
  )
    return null;
  return parent;
}
export async function finishReconstruction(
  tx: SnapshotTx,
  requestId: string,
  outcome: SnapshotApplication,
) {
  if (outcome.status === "pending") return;
  await tx
    .update(schema.regulationReconstructionRequests)
    .set({
      status: outcome.status === "applied" ? "completed" : "failed",
      error:
        outcome.status === "applied"
          ? null
          : { error: "reconstruction_refused", reason: outcome.reason },
    })
    .where(eq(schema.regulationReconstructionRequests.id, requestId));
}
export async function projectReconstructionFailure(
  tx: SnapshotTx,
  c: CaseCommand,
): Promise<SnapshotApplication> {
  const parsed = reconstructionFailureSchema.safeParse(c.data);
  if (!parsed.success)
    return { status: "refused", reason: "invalid reconstruction failure" };
  const [parent] = await tx
    .select()
    .from(schema.regulationReconstructionRequests)
    .where(
      eq(schema.regulationReconstructionRequests.id, parsed.data.requestId),
    );
  if (
    !parent ||
    parent.caseId !== c.caseId ||
    parent.actor !== c.actor ||
    parent.baseRevisionId !== c.baseRevisionId ||
    parent.revisionId !== c.revisionId ||
    c.commandId !== reconstructionIds(parent.id).failureCommandId ||
    parent.status !== "pending"
  )
    return {
      status: "refused",
      reason: "reconstruction failure identity mismatch",
    };
  await tx
    .update(schema.regulationReconstructionRequests)
    .set({
      status: "failed",
      error: { error: parsed.data.error, reason: parsed.data.reason },
    })
    .where(eq(schema.regulationReconstructionRequests.id, parent.id));
  return { status: "applied" };
}
