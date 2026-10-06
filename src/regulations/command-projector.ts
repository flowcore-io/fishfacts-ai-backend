import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { canonicalDigest } from "@/events/json-digest";
import {
  type CaseCommand,
  caseCommandSchema,
  commandPartSchema,
} from "@/events/regulation-case-command";
import {
  type SnapshotManifest,
  decodePart,
} from "@/events/regulation-snapshot-parts";
import { and, eq, sql } from "drizzle-orm";
import {
  type ImmutableConflict,
  SnapshotPartRejectedError,
  quarantineConflict,
} from "./immutable-conflict";
import {
  RegulationSnapshotAssembler,
  type SnapshotApplication,
  type SnapshotTx,
} from "./snapshot-assembler";

export type OrderedCommandApplication = (
  tx: SnapshotTx,
  command: CaseCommand,
) => Promise<SnapshotApplication>;

/** Complete verified commands are staged until their explicit predecessor.
 * Case lock, sequence identity and the application callback commit together.
 * Replay uses Flowcore headers/bodies only, never operational delivery bytes. */
export class RegulationCommandProjector {
  private readonly assembler: RegulationSnapshotAssembler;
  constructor(
    private readonly db: Database,
    private readonly apply: OrderedCommandApplication,
  ) {
    this.assembler = new RegulationSnapshotAssembler(
      db,
      (tx, snapshot, manifest) => this.stageComplete(tx, snapshot, manifest),
    );
  }
  async handle(
    input: unknown,
  ): Promise<SnapshotApplication | ImmutableConflict | { status: "staging" }> {
    let envelope: ReturnType<typeof commandPartSchema.parse>;
    let decoded: ReturnType<typeof decodePart>;
    try {
      envelope = commandPartSchema.parse(input);
      decoded = decodePart(envelope.part);
    } catch (cause) {
      throw new SnapshotPartRejectedError(cause);
    }
    const { part } = decoded;
    // Persist the ordering fence before bytes assemble. This is a projection of
    // this durable event, not a delivery reservation. No tail moves here.
    const conflict = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-command:${part.caseId}`},0))`,
      );
      const [known] = await tx
        .select()
        .from(schema.regulationCommandEnvelopes)
        .where(
          eq(schema.regulationCommandEnvelopes.commandId, part.assemblyId),
        );
      if (known) {
        if (
          known.caseId !== part.caseId ||
          known.sequence !== envelope.sequence ||
          known.predecessorCommandId !== envelope.predecessorCommandId ||
          known.payloadHash !== part.payloadSha256
        )
          return quarantineConflict(tx, {
            caseId: known.caseId,
            assemblyId: part.assemblyId,
            kind: "command-header",
            reason: "conflicting command order header",
            expected: known,
            received: envelope,
          });
        return;
      }
      const [sequence] = await tx
        .select()
        .from(schema.regulationCommandEnvelopes)
        .where(
          and(
            eq(schema.regulationCommandEnvelopes.caseId, part.caseId),
            eq(schema.regulationCommandEnvelopes.sequence, envelope.sequence),
          ),
        );
      if (sequence)
        return quarantineConflict(tx, {
          caseId: sequence.caseId,
          assemblyId: part.assemblyId,
          kind: "command-sequence",
          reason: "conflicting command sequence",
          expected: sequence,
          received: envelope,
        });
      await tx.insert(schema.regulationCommandEnvelopes).values({
        commandId: part.assemblyId,
        caseId: part.caseId,
        sequence: envelope.sequence,
        predecessorCommandId: envelope.predecessorCommandId,
        payloadHash: part.payloadSha256,
      });
    });
    if (conflict) return conflict;
    const result = await this.assembler.handle(part);
    await this.recoverPending(part.caseId);
    return result;
  }
  async resume(commandId: string) {
    const result = await this.assembler.resume(commandId);
    const [header] = await this.db
      .select()
      .from(schema.regulationCommandEnvelopes)
      .where(eq(schema.regulationCommandEnvelopes.commandId, commandId));
    if (header) await this.recoverPending(header.caseId);
    return result;
  }
  /** Each transaction drains at most 32. Continue verified ready work after
   * that boundary without requiring an unrelated Flowcore event. A genuine
   * missing domain dependency stops this pass and is retried by recovery. */
  async recoverPending(caseId: string): Promise<void> {
    for (;;) {
      const [before] = await this.db
        .select()
        .from(schema.regulationCommandTails)
        .where(eq(schema.regulationCommandTails.caseId, caseId));
      const next = (before?.sequence ?? 0) + 1;
      const [ready] = await this.db
        .select()
        .from(schema.regulationCommandReceipts)
        .where(
          and(
            eq(schema.regulationCommandReceipts.caseId, caseId),
            eq(schema.regulationCommandReceipts.sequence, next),
          ),
        );
      if (!ready || ready.status !== "pending") return;
      await this.assembler.resume(ready.commandId);
      const [after] = await this.db
        .select()
        .from(schema.regulationCommandTails)
        .where(eq(schema.regulationCommandTails.caseId, caseId));
      if ((after?.sequence ?? 0) <= (before?.sequence ?? 0)) return;
    }
  }
  private async stageComplete(
    tx: SnapshotTx,
    input: unknown,
    manifest: SnapshotManifest,
  ): Promise<SnapshotApplication> {
    const command = caseCommandSchema.parse(input);
    if (
      command.commandId !== manifest.assemblyId ||
      command.caseId !== manifest.caseId ||
      command.baseRevisionId !== manifest.baseRevisionId ||
      command.revisionId !== manifest.revisionId
    )
      throw new Error("command snapshot identity mismatch");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-command:${command.caseId}`},0))`,
    );
    const [header] = await tx
      .select()
      .from(schema.regulationCommandEnvelopes)
      .where(
        eq(schema.regulationCommandEnvelopes.commandId, command.commandId),
      );
    if (
      !header ||
      header.sequence !== command.sequence ||
      header.predecessorCommandId !== command.predecessorCommandId ||
      header.payloadHash !== manifest.payloadSha256
    )
      throw new Error("command header/body mismatch");
    const payloadHash = canonicalDigest(command);
    const [known] = await tx
      .select()
      .from(schema.regulationCommandReceipts)
      .where(eq(schema.regulationCommandReceipts.commandId, command.commandId));
    if (known && known.payloadHash !== payloadHash)
      throw new Error("conflicting command payload");
    if (!known)
      await tx.insert(schema.regulationCommandReceipts).values({
        commandId: command.commandId,
        caseId: command.caseId,
        sequence: command.sequence,
        payloadHash,
        command,
      });
    await this.drain(tx, command.caseId);
    const [result] = await tx
      .select()
      .from(schema.regulationCommandReceipts)
      .where(eq(schema.regulationCommandReceipts.commandId, command.commandId));
    if (result?.status === "applied") return { status: "applied" };
    if (result?.status === "refused")
      return { status: "refused", reason: result.reason ?? "refused" };
    return {
      status: "pending",
      reason: result?.reason ?? "missing predecessor",
    };
  }
  private async drain(tx: SnapshotTx, caseId: string): Promise<void> {
    let [tail] = await tx
      .select()
      .from(schema.regulationCommandTails)
      .where(eq(schema.regulationCommandTails.caseId, caseId));
    for (let count = 0; count < 32; count++) {
      const next = (tail?.sequence ?? 0) + 1;
      const [receipt] = await tx
        .select()
        .from(schema.regulationCommandReceipts)
        .where(
          and(
            eq(schema.regulationCommandReceipts.caseId, caseId),
            eq(schema.regulationCommandReceipts.sequence, next),
          ),
        );
      if (!receipt) return;
      const command = caseCommandSchema.parse(receipt.command);
      if (
        canonicalDigest(command) !== receipt.payloadHash ||
        command.commandId !== receipt.commandId ||
        command.caseId !== caseId ||
        command.sequence !== next
      )
        throw new Error("command receipt integrity mismatch");
      if (command.predecessorCommandId !== (tail?.commandId ?? null))
        throw new Error("command predecessor conflict");
      const result = await this.apply(tx, command);
      await tx
        .update(schema.regulationCommandReceipts)
        .set({
          status: result.status,
          reason: "reason" in result ? result.reason : null,
        })
        .where(
          eq(schema.regulationCommandReceipts.commandId, command.commandId),
        );
      if (result.status === "pending") return;
      // Refusals are durable outcomes IN the order, not missing commands.
      tail = { caseId, sequence: next, commandId: command.commandId };
      await tx
        .insert(schema.regulationCommandTails)
        .values(tail)
        .onConflictDoUpdate({
          target: schema.regulationCommandTails.caseId,
          set: tail,
        });
      await tx
        .update(schema.regulationSnapshotAssemblies)
        .set({
          status: result.status,
          reason: "reason" in result ? result.reason : null,
        })
        .where(
          eq(schema.regulationSnapshotAssemblies.assemblyId, command.commandId),
        );
    }
  }
}
