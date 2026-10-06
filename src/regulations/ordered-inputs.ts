import * as schema from "@/db/schema";
import { canonicalDigest } from "@/events/json-digest";
import { desc, eq, sql } from "drizzle-orm";
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
  // Intake order is the original serial handler observation, never the
  // producer clock or a content-derived UUID. Retain it across retries.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-intake:${caseId}`},0))`,
  );
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
  if (!known) {
    const [predecessor] = await tx
      .select({ id: schema.regulationOrderedInputs.id })
      .from(schema.regulationOrderedInputs)
      .where(eq(schema.regulationOrderedInputs.caseId, caseId))
      .orderBy(desc(schema.regulationOrderedInputs.observationOrder))
      .limit(1);
    await tx.insert(schema.regulationOrderedInputs).values({
      id,
      caseId,
      kind,
      payload,
      inputHash: hash,
      recordedAt: new Date(recordedAt),
      predecessorInputId: predecessor?.id ?? null,
    });
  }
  return id;
}
