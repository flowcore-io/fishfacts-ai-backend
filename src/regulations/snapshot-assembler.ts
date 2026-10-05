import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import {
  type SnapshotManifest,
  type SnapshotPart,
  decodePart,
  manifestOf,
  reconstructSnapshot,
} from "@/events/regulation-snapshot-parts";
import { and, eq, sql } from "drizzle-orm";

export type SnapshotTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type SnapshotApplication =
  | { status: "applied" }
  | { status: "pending"; reason: string }
  | { status: "refused"; reason: string };
export type SnapshotApplicationHandler = (
  tx: SnapshotTx,
  snapshot: unknown,
  manifest: SnapshotManifest,
) => Promise<SnapshotApplication>;

/** Assembly and revision application share ONE transaction. The callback
 * must use the supplied transaction, never start an independent write. A
 * delayed dependency stays complete/pending and can be resumed; it is not
 * silently acknowledged as a stale draft. Nothing here loads land data. */
export class RegulationSnapshotAssembler {
  constructor(
    private readonly db: Database,
    private readonly apply: SnapshotApplicationHandler,
    private readonly maxIncompletePerCase = 8,
  ) {
    if (
      !Number.isInteger(maxIncompletePerCase) ||
      maxIncompletePerCase < 1 ||
      maxIncompletePerCase > 8
    ) {
      throw new Error("invalid snapshot staging capacity");
    }
  }

  async handle(
    input: unknown,
  ): Promise<SnapshotApplication | { status: "staging" }> {
    // Corrupt encoding/digest is rejected before it can poison valid staging.
    const { part } = decodePart(input);
    const manifest = manifestOf(part);
    return this.db.transaction(async (tx) => {
      // Serialize even first-part inserts and redeliveries on different pods.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-snapshot:${part.assemblyId}`},0))`,
      );
      // A serial event pump must never be blocked before a predecessor by
      // future deliveries occupying all active slots. Queue excess valid bytes
      // durably; each part/assembly remains bounded and hidden from domain reads.
      // Completion executes under this per-case lock, so at most ONE bounded
      // payload is assembled/applied per case at a time. Complete/dependent
      // commands are durable history, not active partial-assembly slots.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-snapshot-capacity:${part.caseId}`},0))`,
      );
      const [capacity] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.regulationSnapshotAssemblies)
        .where(
          and(
            eq(schema.regulationSnapshotAssemblies.caseId, part.caseId),
            eq(schema.regulationSnapshotAssemblies.status, "staging"),
          ),
        );
      const initialStatus =
        (capacity?.count ?? 0) >= this.maxIncompletePerCase
          ? "queued"
          : "staging";
      await tx
        .insert(schema.regulationSnapshotAssemblies)
        .values({
          assemblyId: part.assemblyId,
          caseId: part.caseId,
          manifest,
          status: initialStatus,
        })
        .onConflictDoNothing();
      const [assembly] = await tx
        .select()
        .from(schema.regulationSnapshotAssemblies)
        .where(
          eq(schema.regulationSnapshotAssemblies.assemblyId, part.assemblyId),
        );
      if (!assembly) throw new Error("snapshot assembly missing after insert");
      if (!sameManifest(assembly.manifest, manifest)) {
        // Do not change a completed/applied immutable snapshot for an alien
        // redelivery. Throw preserves its exact original bytes/state.
        throw new Error("conflicting snapshot manifest");
      }
      const [existing] = await tx
        .select({ payload: schema.regulationSnapshotParts.payload })
        .from(schema.regulationSnapshotParts)
        .where(
          and(
            eq(schema.regulationSnapshotParts.assemblyId, part.assemblyId),
            eq(schema.regulationSnapshotParts.partNumber, part.partNumber),
          ),
        );
      if (existing) {
        const previous = existing.payload as SnapshotPart;
        if (
          previous.data !== part.data ||
          previous.partSha256 !== part.partSha256
        ) {
          throw new Error("conflicting snapshot part");
        }
      } else {
        await tx.insert(schema.regulationSnapshotParts).values({
          assemblyId: part.assemblyId,
          partNumber: part.partNumber,
          payload: part,
        });
      }
      if (assembly.status === "applied") return { status: "applied" };
      if (assembly.status === "refused") {
        return { status: "refused", reason: assembly.reason ?? "refused" };
      }
      const rows = await tx
        .select({ payload: schema.regulationSnapshotParts.payload })
        .from(schema.regulationSnapshotParts)
        .where(eq(schema.regulationSnapshotParts.assemblyId, part.assemblyId));
      if (rows.length !== manifest.totalParts) return { status: "staging" };
      const snapshot = reconstructSnapshot(
        manifest,
        rows.map((row) => row.payload as SnapshotPart),
      );
      assertSnapshotIdentity(snapshot, manifest);
      return this.applyComplete(tx, snapshot, manifest);
    });
  }

  /** Call when the named case dependency lands, or from a bounded recovery
   * pass. Failed transactions retain staging so a restart can retry without
   * relying on an in-process promise/TTL. */
  async resume(
    assemblyId: string,
  ): Promise<SnapshotApplication | { status: "staging" }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`regulation-snapshot:${assemblyId}`},0))`,
      );
      const [assembly] = await tx
        .select()
        .from(schema.regulationSnapshotAssemblies)
        .where(eq(schema.regulationSnapshotAssemblies.assemblyId, assemblyId));
      if (
        !assembly ||
        assembly.status === "staging" ||
        assembly.status === "queued"
      )
        return { status: "staging" };
      if (assembly.status === "applied") return { status: "applied" };
      if (assembly.status === "refused") {
        return { status: "refused", reason: assembly.reason ?? "refused" };
      }
      const manifest = assembly.manifest as SnapshotManifest;
      // Parts are the byte authority even when JSONB already carries a cache.
      const parts = await tx
        .select({ payload: schema.regulationSnapshotParts.payload })
        .from(schema.regulationSnapshotParts)
        .where(eq(schema.regulationSnapshotParts.assemblyId, assemblyId));
      const snapshot = reconstructSnapshot(
        manifest,
        parts.map((row) => row.payload as SnapshotPart),
      );
      assertSnapshotIdentity(snapshot, manifest);
      return this.applyComplete(tx, snapshot, manifest);
    });
  }

  private async applyComplete(
    tx: SnapshotTx,
    snapshot: unknown,
    manifest: SnapshotManifest,
  ): Promise<SnapshotApplication> {
    // Caller validates the full event schema/shape digests and handles case
    // locks/CAS before writing any revision. Exceptions roll back both its
    // writes AND this completion marker, so retry never loses an application.
    const result = await this.apply(tx, snapshot, manifest);
    await tx
      .update(schema.regulationSnapshotAssemblies)
      .set({
        status: result.status === "pending" ? "complete" : result.status,
        snapshot,
        reason: "reason" in result ? result.reason : null,
      })
      .where(
        eq(schema.regulationSnapshotAssemblies.assemblyId, manifest.assemblyId),
      );
    return result;
  }
}

function sameManifest(stored: unknown, expected: SnapshotManifest): boolean {
  const value = stored as SnapshotManifest;
  return Object.keys(expected).every(
    (key) =>
      value[key as keyof SnapshotManifest] ===
      expected[key as keyof SnapshotManifest],
  );
}

function assertSnapshotIdentity(
  snapshot: unknown,
  manifest: SnapshotManifest,
): void {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error("snapshot is not an object");
  }
  const object = snapshot as Record<string, unknown>;
  for (const key of ["caseId", "baseRevisionId", "revisionId"] as const) {
    if (object[key] !== manifest[key])
      throw new Error(`snapshot ${key} mismatch`);
  }
}
