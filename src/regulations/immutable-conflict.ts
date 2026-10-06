import * as schema from "@/db/schema";
import { canonicalDigest } from "@/events/json-digest";
import type { SnapshotTx } from "./snapshot-assembler";
export type ImmutableConflict = {
  status: "quarantined";
  conflictId: string;
  reason: string;
};
/** Content identity makes terminal disposition repeatable across restart and
 * event-only replay. This isolates the alien event, never the valid original. */
export async function quarantineConflict(
  tx: SnapshotTx,
  evidence: {
    caseId: string;
    assemblyId: string;
    kind: string;
    reason: string;
    expected: unknown;
    received: unknown;
  },
): Promise<ImmutableConflict> {
  const id = canonicalDigest(evidence);
  await tx
    .insert(schema.regulationImmutableConflicts)
    .values({ id, ...evidence })
    .onConflictDoNothing();
  return { status: "quarantined", conflictId: id, reason: evidence.reason };
}
/** A codec rejection has no trusted immutable header. Callers must isolate it
 * as terminal rather than retrying it like a SQL/network failure. */
export class SnapshotPartRejectedError extends Error {
  readonly terminal = true;
  constructor(cause: unknown, message = "invalid snapshot part") {
    super(message, { cause });
    this.name = "SnapshotPartRejectedError";
  }
}
