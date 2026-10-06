import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import {
  type RegulationRevisionProposed,
  regulationRevisionProposedSchema,
  regulationSnapshotGeometrySchema,
} from "@/events/contracts";
import { canonicalDigest } from "@/events/json-digest";
import {
  SNAPSHOT_PART_EVENT_TYPE,
  type SnapshotPart,
  splitSnapshot,
} from "@/events/regulation-snapshot-parts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { SnapshotPartRejectedError } from "./immutable-conflict";
import {
  OfficialVectorRejectedError,
  hydrateOfficialGeometries,
  proposalGeometry,
} from "./official-vector";
import type { RegulationRevisionProjector } from "./revision-projector";
import { RegulationSnapshotAssembler } from "./snapshot-assembler";

type Ingestion = {
  ingest(
    eventType: string,
    payloads: readonly unknown[],
    flowType?: string,
  ): Promise<string[]>;
};
/** No coastal ordering graph. One immutable proposal is an atomic CAS against
 * its base, staged with bounded exact bytes and applied only from an event. */
export class RegulationRevisionSnapshotRuntime {
  private ingestion?: Ingestion;
  private worker?: ReturnType<typeof setInterval>;
  private recovering = false;
  private recoveryCursor = "";
  private assemblyCursor = "";
  readonly assembler: RegulationSnapshotAssembler;
  constructor(
    private readonly db: Database,
    projector: RegulationRevisionProjector,
  ) {
    this.assembler = new RegulationSnapshotAssembler(
      db,
      async (tx, raw, manifest) => {
        const parsed = regulationRevisionProposedSchema.safeParse(raw);
        if (!parsed.success)
          return { status: "refused", reason: "invalid revision snapshot" };
        const proposal = parsed.data;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-revision:${proposal.caseId}`},0))`,
        );
        const [row] = await tx
          .select()
          .from(schema.regulationCases)
          .where(eq(schema.regulationCases.id, proposal.caseId))
          .for("update");
        if (!row) return { status: "pending", reason: "case not projected" };
        if (row.caseKey !== proposal.caseKey || row.geometryModelVersion !== 0)
          return {
            status: "refused",
            reason: "unrelated or historic modeled case",
          };
        const [known] = await tx
          .select()
          .from(schema.regulationCaseRevisions)
          .where(eq(schema.regulationCaseRevisions.id, proposal.revisionId));
        if (known) {
          if (
            known.caseId !== proposal.caseId ||
            known.baseRevisionId !== proposal.baseRevisionId
          )
            return { status: "refused", reason: "foreign revision identity" };
          const stored = await tx
            .select()
            .from(schema.regulationCaseGeometries)
            .where(eq(schema.regulationCaseGeometries.revisionId, known.id))
            .orderBy(asc(schema.regulationCaseGeometries.position));
          const geometry = await hydrateOfficialGeometries(
            tx,
            stored,
            proposal.caseId,
          );
          const same =
            known.author === proposal.actor &&
            canonicalDigest(known.fields) ===
              canonicalDigest(proposal.fields) &&
            canonicalDigest(known.changes) ===
              canonicalDigest(proposal.changes) &&
            canonicalDigest(
              geometry.map((g) =>
                proposalGeometry(regulationSnapshotGeometrySchema.parse(g)),
              ),
            ) === canonicalDigest(proposal.geometries.map(proposalGeometry));
          return same
            ? { status: "applied" }
            : { status: "refused", reason: "conflicting revision identity" };
        }
        const [base] = await tx
          .select()
          .from(schema.regulationCaseRevisions)
          .where(
            eq(schema.regulationCaseRevisions.id, proposal.baseRevisionId),
          );
        if (!base)
          return { status: "pending", reason: "base revision not projected" };
        if (
          base.caseId !== proposal.caseId ||
          row.currentRevisionId !== proposal.baseRevisionId
        )
          return {
            status: "refused",
            reason: "stale or foreign base revision",
          };
        // The verified complete bytes and ALL domain writes share this transaction.
        try {
          await tx.transaction((inner) =>
            projector.applyProposed(inner, proposal),
          );
        } catch (error) {
          if (
            error instanceof OfficialVectorRejectedError ||
            error instanceof ZodError
          )
            return { status: "refused", reason: error.message };
          throw error;
        }
        return { status: "applied" };
      },
    );
  }
  attach(ingestion: Ingestion) {
    this.ingestion = ingestion;
  }
  async submit(input: RegulationRevisionProposed) {
    const proposal = regulationRevisionProposedSchema.parse(input);
    const parts = splitSnapshot(
      {
        assemblyId: proposal.revisionId,
        caseId: proposal.caseId,
        baseRevisionId: proposal.baseRevisionId,
        revisionId: proposal.revisionId,
      },
      proposal,
    );
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.regulationRevisionDeliveries)
        .values({
          id: proposal.revisionId,
          caseId: proposal.caseId,
          baseRevisionId: proposal.baseRevisionId,
          revisionId: proposal.revisionId,
          actor: proposal.actor,
          payloadHash: parts[0].payloadSha256,
          parts,
        })
        .onConflictDoNothing();
      const [known] = await tx
        .select()
        .from(schema.regulationRevisionDeliveries)
        .where(eq(schema.regulationRevisionDeliveries.id, proposal.revisionId));
      if (
        !known ||
        known.caseId !== proposal.caseId ||
        known.actor !== proposal.actor ||
        known.payloadHash !== parts[0].payloadSha256
      )
        throw new Error("revision operation identity conflict");
    });
    return this.deliver(proposal.revisionId);
  }
  async retry(
    caseId: string,
    id: string,
    actor: string,
    baseRevisionId?: string,
  ) {
    const [row] = await this.db
      .select()
      .from(schema.regulationRevisionDeliveries)
      .where(
        and(
          eq(schema.regulationRevisionDeliveries.id, id),
          eq(schema.regulationRevisionDeliveries.caseId, caseId),
        ),
      );
    if (
      !row ||
      row.actor !== actor ||
      (baseRevisionId && row.baseRevisionId !== baseRevisionId)
    )
      throw new Error("revision operation identity conflict");
    return this.deliver(id);
  }
  async deliver(id: string) {
    const ingestion = this.ingestion;
    if (!ingestion) throw new Error("revision snapshot ingestion not attached");
    // Same operation on multiple pods/recovery cannot concurrently replace its receipt.
    const receipt = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-revision-delivery:${id}`},0))`,
      );
      const [row] = await tx
        .select()
        .from(schema.regulationRevisionDeliveries)
        .where(eq(schema.regulationRevisionDeliveries.id, id));
      if (!row) throw new Error("revision delivery missing");
      const eventIds = (row.eventIds ?? []) as string[];
      if (row.status === "pending") {
        const parts = row.parts as SnapshotPart[];
        for (let i = 0; i < parts.length; i += 8)
          eventIds.push(
            ...(await ingestion.ingest(
              SNAPSHOT_PART_EVENT_TYPE,
              parts.slice(i, i + 8),
            )),
          );
        await tx
          .update(schema.regulationRevisionDeliveries)
          .set({ status: "delivered", eventIds })
          .where(eq(schema.regulationRevisionDeliveries.id, id));
      }
      return {
        eventId: eventIds.at(-1) ?? id,
        operationId: id,
      };
    });
    const [assembly] = await this.db
      .select({ status: schema.regulationSnapshotAssemblies.status })
      .from(schema.regulationSnapshotAssemblies)
      .where(eq(schema.regulationSnapshotAssemblies.assemblyId, id));
    return { ...receipt, projectionPending: assembly?.status !== "applied" };
  }
  async handlePart(part: unknown) {
    try {
      return await this.assembler.handle(part);
    } catch (error) {
      if (error instanceof SnapshotPartRejectedError)
        return { status: "refused", reason: error.message };
      throw error;
    }
  }
  async status(caseId: string, id: string) {
    const [delivery] = await this.db
      .select({
        revisionId: schema.regulationRevisionDeliveries.revisionId,
        reason: schema.regulationRevisionDeliveries.reason,
      })
      .from(schema.regulationRevisionDeliveries)
      .where(
        and(
          eq(schema.regulationRevisionDeliveries.id, id),
          eq(schema.regulationRevisionDeliveries.caseId, caseId),
        ),
      );
    if (!delivery) return null;
    const [assembly] = await this.db
      .select({
        status: schema.regulationSnapshotAssemblies.status,
        reason: schema.regulationSnapshotAssemblies.reason,
      })
      .from(schema.regulationSnapshotAssemblies)
      .where(eq(schema.regulationSnapshotAssemblies.assemblyId, id));
    return {
      operationId: id,
      revisionId: delivery.revisionId,
      status:
        assembly?.status === "applied"
          ? "applied"
          : assembly?.status === "refused"
            ? "refused"
            : "pending",
      reason: assembly?.reason ?? delivery.reason ?? null,
    };
  }
  start() {
    if (!this.worker)
      this.worker = setInterval(
        () =>
          void this.recover().catch((error) =>
            console.error("[RevisionSnapshots] recovery failed", {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        5000,
      );
  }
  stop() {
    if (this.worker) clearInterval(this.worker);
    this.worker = undefined;
  }
  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const pending = await this.db
        .select({ id: schema.regulationRevisionDeliveries.id })
        .from(schema.regulationRevisionDeliveries)
        .where(
          and(
            eq(schema.regulationRevisionDeliveries.status, "pending"),
            gt(schema.regulationRevisionDeliveries.id, this.recoveryCursor),
          ),
        )
        .orderBy(asc(schema.regulationRevisionDeliveries.id))
        .limit(32);
      this.recoveryCursor = pending.at(-1)?.id ?? "";
      // Each failed case is isolated; one unconfirmed emission cannot starve another.
      for (const row of pending)
        try {
          await this.deliver(row.id);
        } catch (error) {
          console.error("[RevisionSnapshots] emission remains pending", {
            operationId: row.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      const complete = await this.db
        .select({ id: schema.regulationSnapshotAssemblies.assemblyId })
        .from(schema.regulationSnapshotAssemblies)
        .where(
          and(
            eq(schema.regulationSnapshotAssemblies.status, "complete"),
            gt(
              schema.regulationSnapshotAssemblies.assemblyId,
              this.assemblyCursor,
            ),
            sql`${schema.regulationSnapshotAssemblies.snapshot} ? 'geometries' and not (${schema.regulationSnapshotAssemblies.snapshot} ? 'commandId')`,
          ),
        )
        .orderBy(asc(schema.regulationSnapshotAssemblies.assemblyId))
        .limit(32);
      this.assemblyCursor = complete.at(-1)?.id ?? "";
      for (const row of complete) {
        try {
          await this.assembler.resume(row.id);
        } catch (error) {
          console.error("[RevisionSnapshots] projection remains pending", {
            operationId: row.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.recovering = false;
    }
  }
}
