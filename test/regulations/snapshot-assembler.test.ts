import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import {
  byteDigest,
  splitSnapshot,
} from "../../src/events/regulation-snapshot-parts";
import {
  RegulationSnapshotAssembler,
  type SnapshotApplicationHandler,
} from "../../src/regulations/snapshot-assembler";

// Own isolated fixture database only. Do not silently skip a failed DB gate.
const connection = createDb(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
);
const testCases: string[] = [];
const identity = () => {
  const ids = {
    assemblyId: randomUUID(),
    caseId: randomUUID(),
    baseRevisionId: randomUUID(),
    revisionId: randomUUID(),
  };
  testCases.push(ids.assemblyId);
  return ids;
};
const payload = (ids: ReturnType<typeof identity>) => ({
  ...ids,
  source: '😀 "\\\n'.repeat(12_000),
  geojson: {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [2, 3],
          [3, 3],
          [3, 2],
          [2, 2],
        ],
      ],
      [
        [
          [20, 0],
          [30, 0],
          [30, 10],
          [20, 10],
          [20, 0],
        ],
        [
          [22, 2],
          [22, 3],
          [23, 3],
          [23, 2],
          [22, 2],
        ],
      ],
    ],
  },
});
let callbackCount = 0;
const apply: SnapshotApplicationHandler = async (tx, snapshot, manifest) => {
  callbackCount++;
  await tx.execute(
    sql`insert into coastal_transport_test.applied(id,snapshot) values (${manifest.assemblyId},${JSON.stringify(snapshot)}::jsonb)`,
  );
  return { status: "applied" };
};
const assembler = () => new RegulationSnapshotAssembler(connection.db, apply);
const countApplied = async (id: string) => {
  const rows = await connection.client<
    { count: number }[]
  >`select count(*)::int count from coastal_transport_test.applied where id=${id}`;
  return rows[0].count;
};
beforeAll(async () => {
  await runMigrations(connection.db, connection.client);
  await connection.client`create schema if not exists coastal_transport_test`;
  await connection.client`create table if not exists coastal_transport_test.applied(id text primary key,snapshot jsonb not null)`;
});
afterAll(async () => {
  for (const id of testCases) {
    await connection.db
      .delete(schema.regulationImmutableConflicts)
      .where(eq(schema.regulationImmutableConflicts.assemblyId, id));
    await connection.db
      .delete(schema.regulationSnapshotParts)
      .where(eq(schema.regulationSnapshotParts.assemblyId, id));
    await connection.db
      .delete(schema.regulationSnapshotAssemblies)
      .where(eq(schema.regulationSnapshotAssemblies.assemblyId, id));
    await connection.client`delete from coastal_transport_test.applied where id=${id}`;
  }
  await connection.client.end();
});

describe("durable immutable snapshot assembly", () => {
  test("missing parts are not visible; reordered parts/JSONB preserve every polygon and hole", async () => {
    const ids = identity();
    const snapshot = payload(ids);
    const parts = splitSnapshot(ids, snapshot);
    const handler = assembler();
    expect(await handler.handle(parts.at(-1))).toEqual({ status: "staging" });
    expect(await countApplied(ids.assemblyId)).toBe(0);
    for (const part of parts.slice(0, -2).reverse()) await handler.handle(part);
    expect(await countApplied(ids.assemblyId)).toBe(0);
    expect(await handler.handle(parts.at(-2))).toEqual({ status: "applied" });
    const [row] =
      await connection.client`select snapshot from coastal_transport_test.applied where id=${ids.assemblyId}`;
    expect(row.snapshot).toEqual(snapshot);
    const [topology] =
      await connection.client`select ST_NumGeometries(g) parts,(select sum(ST_NumInteriorRings(d.geom)) from ST_Dump(g) d)::int holes,ST_IsValid(g) valid from (select ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(snapshot.geojson)}),4326) g) q`;
    expect(topology).toEqual({ parts: 2, holes: 2, valid: true });
  });

  test("restart and concurrent duplicate completion apply exactly once", async () => {
    const ids = identity();
    const parts = splitSnapshot(ids, payload(ids));
    for (const part of parts.slice(0, -1)) await assembler().handle(part);
    const before = callbackCount;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, () => assembler().handle(parts.at(-1))),
    );
    expect(performance.now() - started).toBeLessThan(5000);
    expect(callbackCount - before).toBe(1);
    expect(await countApplied(ids.assemblyId)).toBe(1);
    expect(await assembler().resume(ids.assemblyId)).toEqual({
      status: "applied",
    });
    expect(callbackCount - before).toBe(1);
  });

  test("conflicting duplicate/header and corruption never overwrite staged bytes or project partial state", async () => {
    const ids = identity();
    const parts = splitSnapshot(ids, payload(ids));
    const handler = assembler();
    await handler.handle(parts[0]);
    const changed = Buffer.from(parts[0].data, "base64");
    changed[100] ^= 1;
    const alienPart = {
      ...parts[0],
      data: changed.toString("base64"),
      partSha256: byteDigest(changed),
    };
    const outcome = await handler.handle(alienPart);
    expect(outcome).toMatchObject({
      status: "quarantined",
      reason: "conflicting snapshot part",
    });
    expect(await assembler().handle(alienPart)).toEqual(outcome);
    const alienManifest = { ...parts[1], revisionId: randomUUID() };
    const manifestOutcome = await handler.handle(alienManifest);
    expect(manifestOutcome).toMatchObject({
      status: "quarantined",
      reason: "conflicting snapshot manifest",
    });
    const conflicts = await connection.db
      .select()
      .from(schema.regulationImmutableConflicts)
      .where(
        eq(schema.regulationImmutableConflicts.assemblyId, ids.assemblyId),
      );
    expect(conflicts).toHaveLength(2);
    expect(conflicts.find((c) => c.kind === "snapshot-part")?.received).toEqual(
      alienPart,
    );
    await connection.db
      .delete(schema.regulationImmutableConflicts)
      .where(
        eq(schema.regulationImmutableConflicts.assemblyId, ids.assemblyId),
      );
    expect(await assembler().handle(alienPart)).toEqual(outcome);
    expect(await assembler().handle(alienManifest)).toEqual(manifestOutcome);
    await expect(
      handler.handle({ ...parts[1], data: "bad" }),
    ).rejects.toThrow();
    expect(await countApplied(ids.assemblyId)).toBe(0);
    const [stored] = await connection.db
      .select()
      .from(schema.regulationSnapshotParts)
      .where(eq(schema.regulationSnapshotParts.assemblyId, ids.assemblyId));
    expect(stored.payload).toEqual(parts[0]);
    for (const part of parts.slice(1)) await handler.handle(part);
    expect(await countApplied(ids.assemblyId)).toBe(1);
  });

  test("callback crash rolls back application AND completion; final-part retry recovers", async () => {
    const ids = identity();
    const parts = splitSnapshot(ids, payload(ids));
    for (const part of parts.slice(0, -1)) await assembler().handle(part);
    const crash = new RegulationSnapshotAssembler(
      connection.db,
      async (tx, snapshot, manifest) => {
        await apply(tx, snapshot, manifest);
        throw new Error("crash before commit");
      },
    );
    await expect(crash.handle(parts.at(-1))).rejects.toThrow(
      "crash before commit",
    );
    expect(await countApplied(ids.assemblyId)).toBe(0);
    const [row] = await connection.db
      .select()
      .from(schema.regulationSnapshotAssemblies)
      .where(
        eq(schema.regulationSnapshotAssemblies.assemblyId, ids.assemblyId),
      );
    expect(row.status).toBe("staging");
    expect(await assembler().handle(parts.at(-1))).toEqual({
      status: "applied",
    });
    expect(await countApplied(ids.assemblyId)).toBe(1);
  });

  test("missing dependency stays complete/pending across process restart and can be resumed without land", async () => {
    const ids = identity();
    const parts = splitSnapshot(ids, payload(ids));
    const pending = new RegulationSnapshotAssembler(
      connection.db,
      async () => ({ status: "pending", reason: "base not projected yet" }),
    );
    for (const part of parts) await pending.handle(part);
    expect(await countApplied(ids.assemblyId)).toBe(0);
    const [row] = await connection.db
      .select()
      .from(schema.regulationSnapshotAssemblies)
      .where(
        eq(schema.regulationSnapshotAssemblies.assemblyId, ids.assemblyId),
      );
    expect(row.status).toBe("complete");
    expect(await assembler().resume(ids.assemblyId)).toEqual({
      status: "applied",
    });
    expect(await countApplied(ids.assemblyId)).toBe(1);
  });

  test("whole-payload mismatch and foreign snapshot identity never invoke application", async () => {
    const ids = identity();
    const parts = splitSnapshot(ids, payload(ids));
    const bad = parts.map((p) => ({ ...p, payloadSha256: "a".repeat(64) }));
    for (const part of bad.slice(0, -1)) await assembler().handle(part);
    const before = callbackCount;
    await expect(assembler().handle(bad.at(-1))).rejects.toThrow(
      "checksum mismatch",
    );
    expect(callbackCount).toBe(before);
    expect(await countApplied(ids.assemblyId)).toBe(0);
    const foreign = identity();
    const foreignParts = splitSnapshot(foreign, {
      ...payload(foreign),
      caseId: randomUUID(),
    });
    for (const part of foreignParts.slice(0, -1))
      await assembler().handle(part);
    await expect(assembler().handle(foreignParts.at(-1))).rejects.toThrow(
      "caseId mismatch",
    );
    expect(await countApplied(foreign.assemblyId)).toBe(0);
  });

  test("active partial slots queue excess durable bytes without starving a predecessor or changing visibility", async () => {
    const future = identity();
    const predecessor = { ...identity(), caseId: future.caseId };
    const a = splitSnapshot(future, payload(future));
    const b = splitSnapshot(predecessor, payload(predecessor));
    const handler = new RegulationSnapshotAssembler(connection.db, apply, 1);
    await handler.handle(a[0]);
    expect(await handler.handle(b[0])).toEqual({ status: "staging" });
    const [queued] = await connection.db
      .select()
      .from(schema.regulationSnapshotAssemblies)
      .where(
        eq(
          schema.regulationSnapshotAssemblies.assemblyId,
          predecessor.assemblyId,
        ),
      );
    expect(queued.status).toBe("queued");
    expect(await countApplied(predecessor.assemblyId)).toBe(0);
    for (const part of b.slice(1)) await handler.handle(part);
    expect(await countApplied(predecessor.assemblyId)).toBe(1);
    for (const part of a.slice(1)) await handler.handle(part);
    expect(await countApplied(future.assemblyId)).toBe(1);
  });

  test("clean DB transport replay after staging deletion recreates exact output without geometry recomputation", async () => {
    const ids = identity();
    const snapshot = payload(ids);
    const parts = splitSnapshot(ids, snapshot);
    for (const part of parts) await assembler().handle(part);
    await connection.db
      .delete(schema.regulationSnapshotParts)
      .where(eq(schema.regulationSnapshotParts.assemblyId, ids.assemblyId));
    await connection.db
      .delete(schema.regulationSnapshotAssemblies)
      .where(
        eq(schema.regulationSnapshotAssemblies.assemblyId, ids.assemblyId),
      );
    await connection.client`delete from coastal_transport_test.applied where id=${ids.assemblyId}`;
    for (const part of [...parts].reverse()) await assembler().handle(part);
    const [row] =
      await connection.client`select snapshot from coastal_transport_test.applied where id=${ids.assemblyId}`;
    expect(row.snapshot).toEqual(snapshot);
  });
});
