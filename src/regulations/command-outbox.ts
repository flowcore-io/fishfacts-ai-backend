import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { canonicalDigest, canonicalJson } from "@/events/json-digest";
import {
  type CaseCommandInput,
  type CommandPart,
  caseCommandSchema,
} from "@/events/regulation-case-command";
import {
  SNAPSHOT_EVENT_BUDGET_BYTES,
  type SnapshotManifest,
  type SnapshotPart,
  reconstructSnapshot,
  splitSnapshot,
} from "@/events/regulation-snapshot-parts";
import { desc, eq, sql } from "drizzle-orm";

export type DurablePartEmitter = (
  parts: readonly CommandPart[],
) => Promise<{ eventIds: string[] }>;
/** The integration must await a processed barrier on the SAME Flowcore command
 * pump after boot/replay catchup. A reservation alone is never such proof. */
export type CommandCatchupBarrier = () => Promise<{ barrierId: string }>;

export class RegulationCommandOutbox {
  constructor(
    private readonly db: Database,
    private readonly emit: DurablePartEmitter,
    private readonly catchup: CommandCatchupBarrier,
  ) {}

  async reserve(input: CaseCommandInput): Promise<string> {
    // Reject serialization that could silently change source evidence.
    const inputHash = canonicalDigest(input);
    // No allocation until historical delivery/projection is reconciled. This
    // callback is deliberately mandatory, rather than defaulting to "ready".
    const barrier = await this.catchup();
    if (!barrier.barrierId)
      throw new Error("command replay catchup not established");
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-command-delivery:${input.caseId}`},0))`,
      );
      const [known] = await tx
        .select()
        .from(schema.regulationCommandDeliveries)
        .where(
          eq(schema.regulationCommandDeliveries.commandId, input.commandId),
        );
      if (known) {
        if (known.caseId !== input.caseId || known.inputHash !== inputHash)
          throw new Error("command id conflict");
        return known.commandId;
      }
      // Event-derived identity survives loss of the operational retry cache.
      // Never allocate a second sequence/clock under a known command UUID.
      const [header] = await tx
        .select()
        .from(schema.regulationCommandEnvelopes)
        .where(
          eq(schema.regulationCommandEnvelopes.commandId, input.commandId),
        );
      if (header) {
        if (header.caseId !== input.caseId)
          throw new Error("command id conflict");
        const [assembly] = await tx
          .select()
          .from(schema.regulationSnapshotAssemblies)
          .where(
            eq(schema.regulationSnapshotAssemblies.assemblyId, input.commandId),
          );
        const rows = await tx
          .select()
          .from(schema.regulationSnapshotParts)
          .where(eq(schema.regulationSnapshotParts.assemblyId, input.commandId))
          .orderBy(schema.regulationSnapshotParts.partNumber);
        const manifest = assembly?.manifest as SnapshotManifest | undefined;
        if (!manifest || rows.length !== manifest.totalParts)
          throw new Error(
            "known command incomplete; await exact durable replay",
          );
        const original = caseCommandSchema.parse(
          reconstructSnapshot(
            manifest,
            rows.map((row) => row.payload as SnapshotPart),
          ),
        );
        const {
          schemaVersion: _version,
          sequence: _sequence,
          predecessorCommandId: _predecessor,
          recordedAt: _clock,
          ...originalInput
        } = original;
        if (
          canonicalDigest(originalInput) !== inputHash ||
          original.commandId !== header.commandId ||
          original.sequence !== header.sequence ||
          original.predecessorCommandId !== header.predecessorCommandId ||
          manifest.payloadSha256 !== header.payloadHash
        )
          throw new Error("command id conflict");
        // Re-emit original byte parts if a caller needs a durable receipt. No
        // geometry serialization or regenerated recordedAt is permitted here.
        const parts: CommandPart[] = rows.map((row) => ({
          schemaVersion: 1,
          sequence: header.sequence,
          predecessorCommandId: header.predecessorCommandId,
          part: row.payload as SnapshotPart,
        }));
        await tx.insert(schema.regulationCommandDeliveries).values({
          commandId: input.commandId,
          caseId: input.caseId,
          sequence: header.sequence,
          predecessorCommandId: header.predecessorCommandId,
          inputHash,
          payloadHash: header.payloadHash,
          parts,
        });
        return input.commandId;
      }
      const [tail] = await tx
        .select()
        .from(schema.regulationCommandTails)
        .where(eq(schema.regulationCommandTails.caseId, input.caseId));
      const [delivered] = await tx
        .select()
        .from(schema.regulationCommandDeliveries)
        .where(eq(schema.regulationCommandDeliveries.caseId, input.caseId))
        .orderBy(desc(schema.regulationCommandDeliveries.sequence))
        .limit(1);
      const [observed] = await tx
        .select()
        .from(schema.regulationCommandEnvelopes)
        .where(eq(schema.regulationCommandEnvelopes.caseId, input.caseId))
        .orderBy(desc(schema.regulationCommandEnvelopes.sequence))
        .limit(1);
      // An empty operational outbox is safe only after verified replay catchup.
      // Partial/complete-but-blocked events whose delivery bytes are unavailable
      // fence new allocations; never reuse their sequence or invent a successor.
      const highestKnown = Math.max(
        tail?.sequence ?? 0,
        delivered?.sequence ?? 0,
      );
      if ((observed?.sequence ?? 0) > highestKnown)
        throw new Error("unreconciled command delivery");
      if (
        delivered &&
        delivered.sequence > (tail?.sequence ?? 0) &&
        delivered.status !== "acknowledged"
      )
        throw new Error("case delivery pending");
      const previous =
        delivered && delivered.sequence > (tail?.sequence ?? 0)
          ? delivered
          : tail;
      const sequence = (previous?.sequence ?? 0) + 1;
      const command = caseCommandSchema.parse({
        ...input,
        schemaVersion: 1,
        sequence,
        predecessorCommandId: previous?.commandId ?? null,
        recordedAt: new Date().toISOString(),
      });
      // Canonicalize once before slicing. Base64 data retains the exact bytes
      // through JSONB operational caching; retries never reserialize geometry.
      const canonical = JSON.parse(canonicalJson(command));
      const parts: CommandPart[] = splitSnapshot(
        {
          assemblyId: input.commandId,
          caseId: input.caseId,
          baseRevisionId: input.baseRevisionId,
          revisionId: input.revisionId,
        },
        canonical,
      ).map((part) => ({
        schemaVersion: 1,
        sequence,
        predecessorCommandId: command.predecessorCommandId,
        part,
      }));
      if (
        parts.some(
          (part) =>
            Buffer.byteLength(JSON.stringify(part)) >
            SNAPSHOT_EVENT_BUDGET_BYTES,
        )
      )
        throw new Error("command envelope resource limit");
      await tx.insert(schema.regulationCommandDeliveries).values({
        commandId: input.commandId,
        caseId: input.caseId,
        sequence,
        predecessorCommandId: command.predecessorCommandId,
        inputHash,
        payloadHash: parts[0].part.payloadSha256,
        parts,
      });
      return input.commandId;
    });
  }

  /** Delivery holds its own case lock but does NOT await domain projection.
   * Only confirmed durable ingestion receipts can acknowledge the reservation.
   * Network errors leave exactly the original bytes reserved for retry. */
  async deliver(
    commandId: string,
  ): Promise<{ status: "acknowledged"; eventIds: string[] }> {
    const [identity] = await this.db
      .select({ caseId: schema.regulationCommandDeliveries.caseId })
      .from(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.commandId, commandId));
    if (!identity) throw new Error("unknown command delivery");
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-command-delivery:${identity.caseId}`},0))`,
      );
      const [delivery] = await tx
        .select()
        .from(schema.regulationCommandDeliveries)
        .where(eq(schema.regulationCommandDeliveries.commandId, commandId));
      if (!delivery) throw new Error("unknown command delivery");
      if (delivery.status === "acknowledged")
        return {
          status: "acknowledged",
          eventIds: delivery.eventIds as string[],
        };
      const parts = delivery.parts as CommandPart[];
      const receipt = await this.emit(parts);
      if (
        receipt.eventIds.length !== parts.length ||
        receipt.eventIds.some((id) => typeof id !== "string" || id.length === 0)
      )
        throw new Error("incomplete durable command receipt");
      await tx
        .update(schema.regulationCommandDeliveries)
        .set({ status: "acknowledged", eventIds: receipt.eventIds })
        .where(eq(schema.regulationCommandDeliveries.commandId, commandId));
      return { status: "acknowledged", eventIds: receipt.eventIds };
    });
  }

  /** Bounded recovery uses durable cached bytes only, not a new command id.
   * The caller schedules retries; the outbox never applies domain mutations. */
  async recover(limit = 8): Promise<void> {
    const rows = await this.db
      .select({ commandId: schema.regulationCommandDeliveries.commandId })
      .from(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.status, "reserved"))
      .orderBy(schema.regulationCommandDeliveries.sequence)
      .limit(Math.max(1, Math.min(limit, 32)));
    for (const row of rows) await this.deliver(row.commandId);
  }
}
