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
  ): Promise<SnapshotApplication | { status: "staging" }> {
    const envelope = commandPartSchema.parse(input);
    const { part } = decodePart(envelope.part);
    // Persist the ordering fence before bytes assemble. This is a projection of
    // this durable event, not a delivery reservation. No tail moves here.
    await this.db.transaction(async (tx) => {
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
          throw new Error("conflicting command order header");
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
      if (sequence) throw new Error("conflicting command sequence");
      await tx.insert(schema.regulationCommandEnvelopes).values({
        commandId: part.assemblyId,
        caseId: part.caseId,
        sequence: envelope.sequence,
        predecessorCommandId: envelope.predecessorCommandId,
        payloadHash: part.payloadSha256,
      });
    });
    return this.assembler.handle(part);
  }
  async resume(commandId: string) {
    return this.assembler.resume(commandId);
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
