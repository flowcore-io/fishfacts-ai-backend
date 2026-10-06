import * as schema from "@/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import type { SnapshotTx } from "./snapshot-assembler";
export async function pendingCaseInput(
  tx: SnapshotTx,
  row: typeof schema.regulationCases.$inferSelect,
  ownCommandId: string,
) {
  const [input] = await tx
    .select({ id: schema.regulationOrderedInputs.id })
    .from(schema.regulationOrderedInputs)
    .where(
      and(
        eq(schema.regulationOrderedInputs.caseId, row.id),
        eq(schema.regulationOrderedInputs.status, "pending"),
        ne(schema.regulationOrderedInputs.id, ownCommandId),
      ),
    )
    .limit(1);
  if (input) return true;
  if (row.sourceType !== "fiskeridir-jmelding") return false;
  const chunks = await tx.execute(
    sql`select 1 from ${schema.jmeldingChunkQueue} where ${schema.jmeldingChunkQueue.payload}->>'jmNumber' = ${row.sourceRef} and coalesce(${schema.jmeldingChunkQueue.payload}->>'region','NO') = 'NO' limit 1`,
  );
  return chunks.length > 0;
}
