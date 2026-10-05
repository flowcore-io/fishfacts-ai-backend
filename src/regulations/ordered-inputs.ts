import * as schema from "@/db/schema";
import { canonicalDigest } from "@/events/json-digest";
import { eq } from "drizzle-orm";
import { revisionIdFor } from "./ids";
import { quarantineConflict } from "./immutable-conflict";
import type { SnapshotTx } from "./snapshot-assembler";
export class ModeledCaseRequiresOrderError extends Error {}

export async function stageOrderedInput(
  tx: SnapshotTx,
  caseId: string,
  kind: string,
  identity: string,
  payload: unknown,
  recordedAt: string,
) {
  const id = revisionIdFor(`ordered-input:${kind}:${identity}`);
  const hash = canonicalDigest(payload);
  const [known] = await tx
    .select()
    .from(schema.regulationOrderedInputs)
    .where(eq(schema.regulationOrderedInputs.id, id));
  if (
    known &&
    (known.caseId !== caseId || known.kind !== kind || known.inputHash !== hash)
  ) {
    await quarantineConflict(tx, {
      caseId: known.caseId,
      assemblyId: id,
      kind: "ordered-input",
      reason: "conflicting original ordered input",
      expected: known,
      received: { caseId, kind, inputHash: hash },
    });
    return id;
  }
  if (!known)
    await tx.insert(schema.regulationOrderedInputs).values({
      id,
      caseId,
      kind,
      payload,
      inputHash: hash,
      recordedAt: new Date(recordedAt),
    });
  return id;
}
