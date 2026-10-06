import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type {
  CaseCommandInput,
  CommandPart,
} from "../../src/events/regulation-case-command";
import {
  manifestOf,
  reconstructSnapshot,
  splitSnapshot,
} from "../../src/events/regulation-snapshot-parts";
import { RegulationCommandOutbox } from "../../src/regulations/command-outbox";
import {
  type OrderedCommandApplication,
  RegulationCommandProjector,
} from "../../src/regulations/command-projector";
const connection = createDb(
  process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
);
const cases: string[] = [];
const caseId = () => {
  const id = randomUUID();
  cases.push(id);
  return id;
};
const input = (
  id: string,
  operation: CaseCommandInput["operation"] = "proposal",
): CaseCommandInput => ({
  caseId: id,
  commandId: randomUUID(),
  baseRevisionId: randomUUID(),
  revisionId: randomUUID(),
  operation,
  actor: "admin:fixture",
  data: { text: '😀 Øst \\"'.repeat(5000) },
});
const emitted = new Map<string, readonly CommandPart[]>();
const partsOf = (id: string): readonly CommandPart[] => {
  const parts = emitted.get(id);
  if (!parts) throw new Error("fixture command was not emitted");
  return parts;
};
let emissionMode: "success" | "before" | "after" = "success";
let emissionCount = 0;
const emit = async (parts: readonly CommandPart[]) => {
  emissionCount++;
  if (emissionMode === "before") throw Error("crash before emit");
  const id = parts[0].part.assemblyId;
  const known = emitted.get(id);
  if (known) expect(parts).toEqual(known);
  emitted.set(id, parts);
  if (emissionMode === "after")
    throw Error("lost acknowledgement after durable emission");
  return { eventIds: parts.map(() => randomUUID()) };
};
const caughtup = async () => ({
  barrierId: "fixture-processed-common-flow-barrier",
});
const outbox = () => new RegulationCommandOutbox(connection.db, emit, caughtup);
const apply: OrderedCommandApplication = async (tx, c) => {
  if ((c.data as { refuse?: boolean }).refuse)
    return { status: "refused", reason: "fixture stale base" };
  await tx.execute(
    sql`insert into coastal_order_test.effects(case_id,sequence,command_id,operation) values (${c.caseId},${c.sequence},${c.commandId},${c.operation})`,
  );
  return { status: "applied" };
};
const projector = (handler = apply) =>
  new RegulationCommandProjector(connection.db, handler);
const effects = async (id: string) =>
  connection.client<
    { sequence: number; operation: string }[]
  >`select sequence::int,operation from coastal_order_test.effects where case_id=${id} order by sequence`;
const cleanupProjection = async (id: string) => {
  const rows = await connection.db
    .select()
    .from(schema.regulationCommandEnvelopes)
    .where(eq(schema.regulationCommandEnvelopes.caseId, id));
  for (const row of rows) {
    await connection.db
      .delete(schema.regulationSnapshotParts)
      .where(eq(schema.regulationSnapshotParts.assemblyId, row.commandId));
    await connection.db
      .delete(schema.regulationSnapshotAssemblies)
      .where(eq(schema.regulationSnapshotAssemblies.assemblyId, row.commandId));
  }
  await connection.db
    .delete(schema.regulationImmutableConflicts)
    .where(eq(schema.regulationImmutableConflicts.caseId, id));
  await connection.db
    .delete(schema.regulationCommandReceipts)
    .where(eq(schema.regulationCommandReceipts.caseId, id));
  await connection.db
    .delete(schema.regulationCommandEnvelopes)
    .where(eq(schema.regulationCommandEnvelopes.caseId, id));
  await connection.db
    .delete(schema.regulationCommandTails)
    .where(eq(schema.regulationCommandTails.caseId, id));
  await connection.client`delete from coastal_order_test.effects where case_id=${id}`;
};
beforeAll(async () => {
  await runMigrations(connection.db, connection.client);
  await connection.client`create schema if not exists coastal_order_test`;
  await connection.client`create table if not exists coastal_order_test.effects(case_id text,sequence bigint,command_id text primary key,operation text,unique(case_id,sequence))`;
});
afterAll(async () => {
  for (const id of cases) {
    await cleanupProjection(id);
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
  }
  await connection.client.end();
});
describe("case command delivery and deterministic projection", () => {
  test("producer crash before emit and after emit/before ack retries SAME exact command; reservation is never a domain mutation", async () => {
    const id = caseId();
    const request = input(id);
    await outbox().reserve(request);
    expect(await effects(id)).toHaveLength(0);
    emissionMode = "before";
    await expect(outbox().deliver(request.commandId)).rejects.toThrow(
      "before emit",
    );
    expect(emitted.has(request.commandId)).toBe(false);
    await expect(outbox().reserve(input(id))).rejects.toThrow(
      "delivery pending",
    );
    emissionMode = "after";
    await expect(outbox().deliver(request.commandId)).rejects.toThrow(
      "lost acknowledgement",
    );
    const bytes = emitted.get(request.commandId);
    expect(bytes).toBeDefined();
    expect(await outbox().reserve(request)).toBe(request.commandId);
    await expect(
      outbox().reserve({ ...request, data: { different: true } }),
    ).rejects.toThrow("id conflict");
    emissionMode = "success";
    await outbox().recover();
    expect(emitted.get(request.commandId)).toEqual(bytes);
    expect(await effects(id)).toHaveLength(0);
    const before = emissionCount;
    await outbox().deliver(request.commandId);
    expect(emissionCount).toBe(before);
    for (const part of partsOf(request.commandId))
      await projector().handle(part);
    expect([...(await effects(id))]).toEqual([
      { sequence: 1, operation: "proposal" },
    ]);
  });
  test("two producers serialize reservations; acknowledged-but-unprojected commands have one predecessor and safe staged application", async () => {
    const id = caseId();
    const a = input(id, "source");
    const b = input(id, "approval");
    const started = performance.now();
    const result = await Promise.allSettled([
      outbox().reserve(a),
      outbox().reserve(b),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(5000);
    const first = result[0].status === "fulfilled" ? a : b;
    const second = first === a ? b : a;
    await outbox().deliver(first.commandId);
    await outbox().reserve(second);
    await outbox().deliver(second.commandId);
    const secondParts = partsOf(second.commandId);
    expect(secondParts[0].sequence).toBe(2);
    expect(secondParts[0].predecessorCommandId).toBe(first.commandId);
    for (const p of [...secondParts].reverse()) await projector().handle(p);
    expect(await effects(id)).toHaveLength(0);
    for (const p of [...partsOf(first.commandId)].reverse())
      await projector().handle(p);
    expect([...(await effects(id))]).toEqual([
      { sequence: 1, operation: first.operation },
      { sequence: 2, operation: second.operation },
    ]);
  });
  test("source/proposal/validation/approval/revoke share order; refusal advances chain; shuffled replay with EMPTY operational outbox gives identical outcomes", async () => {
    const id = caseId();
    const operations: CaseCommandInput["operation"][] = [
      "source",
      "proposal",
      "validation",
      "approval",
      "revoke",
    ];
    const all: CommandPart[] = [];
    const ids: string[] = [];
    for (const operation of operations) {
      const r = input(id, operation);
      if (operation === "proposal") r.data = { refuse: true };
      ids.push(r.commandId);
      await outbox().reserve(r);
      await outbox().deliver(r.commandId);
      all.push(...partsOf(r.commandId));
    }
    const p = projector();
    for (const part of [...all].reverse()) await p.handle(part);
    const expected = [
      { sequence: 1, operation: "source" },
      { sequence: 3, operation: "validation" },
      { sequence: 4, operation: "approval" },
      { sequence: 5, operation: "revoke" },
    ];
    expect([...(await effects(id))]).toEqual(expected);
    const [refusal] = await connection.db
      .select()
      .from(schema.regulationCommandReceipts)
      .where(eq(schema.regulationCommandReceipts.commandId, ids[1]));
    expect(refusal.status).toBe("refused");
    await cleanupProjection(id);
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
    for (const part of [...all].reverse()) await projector().handle(part);
    expect([...(await effects(id))]).toEqual(expected);
    const next = input(id);
    await outbox().reserve(next);
    await outbox().deliver(next.commandId);
    expect(partsOf(next.commandId)[0].sequence).toBe(6);
  });
  test("ten-command reverse replay with empty outbox cannot starve earliest predecessor in an awaited serial pump", async () => {
    const id = caseId();
    const all: CommandPart[] = [];
    for (let i = 0; i < 10; i++) {
      const r = input(id);
      await outbox().reserve(r);
      await outbox().deliver(r.commandId);
      all.push(...partsOf(r.commandId));
    }
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
    const started = performance.now();
    const p = projector();
    // Installed pump awaits each event. Throw/retry on the ninth command
    // would prevent the earliest predecessor from ever being delivered.
    for (const part of [...all].reverse()) await p.handle(part);
    expect(performance.now() - started).toBeLessThan(10000);
    expect(await effects(id)).toHaveLength(10);
  });

  test("forty-command reverse backlog drains across the 32 transaction boundary without another event", async () => {
    const id = caseId();
    const all: CommandPart[] = [];
    for (let n = 0; n < 40; n++) {
      const r = input(id);
      r.data = { n };
      await outbox().reserve(r);
      await outbox().deliver(r.commandId);
      all.push(...partsOf(r.commandId));
    }
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
    const started = performance.now();
    for (const part of [...all].reverse()) await projector().handle(part);
    expect(await effects(id)).toHaveLength(40);
    expect(performance.now() - started).toBeLessThan(10000);
    await projector().recoverPending(id);
    expect(await effects(id)).toHaveLength(40);
  });
  test("seventy reversed pending commands recover after a second-batch crash and restart, including refusals", async () => {
    const id = caseId();
    const all: CommandPart[] = [];
    for (let n = 0; n < 70; n++) {
      const r = input(id);
      r.data = { n };
      await outbox().reserve(r);
      await outbox().deliver(r.commandId);
      all.push(...partsOf(r.commandId));
    }
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
    let ready = false;
    let crash = false;
    const handler: OrderedCommandApplication = async (tx, c) => {
      if (!ready)
        return { status: "pending", reason: "missing domain dependency" };
      if (crash && c.sequence === 33) throw Error("second-batch crash");
      if (c.sequence === 35 || c.sequence === 69)
        return { status: "refused", reason: "fixture refusal" };
      return apply(tx, c);
    };
    const tail = async () => {
      const [row] = await connection.db
        .select()
        .from(schema.regulationCommandTails)
        .where(eq(schema.regulationCommandTails.caseId, id));
      return row?.sequence ?? 0;
    };
    for (const part of [...all].reverse())
      await projector(handler).handle(part);
    await projector(handler).recoverPending(id);
    expect(await tail()).toBe(0);
    expect(await effects(id)).toHaveLength(0);
    ready = true;
    crash = true;
    await expect(projector(handler).recoverPending(id)).rejects.toThrow(
      "second-batch crash",
    );
    expect(await tail()).toBe(32);
    expect(await effects(id)).toHaveLength(32);
    crash = false;
    const started = performance.now();
    await projector(handler).recoverPending(id);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await tail()).toBe(70);
    expect(await effects(id)).toHaveLength(68);
    const receipts = await connection.db
      .select()
      .from(schema.regulationCommandReceipts)
      .where(eq(schema.regulationCommandReceipts.caseId, id));
    expect(receipts.filter((r) => r.status === "refused")).toHaveLength(2);
    expect(receipts.filter((r) => r.status === "pending")).toHaveLength(0);
    await projector(handler).recoverPending(id);
    expect(await effects(id)).toHaveLength(68);
  });
  test("durable command UUID binds original actor/input/sequence/bytes after operational cache deletion", async () => {
    const id = caseId();
    const r = input(id);
    await outbox().reserve(r);
    await outbox().deliver(r.commandId);
    const original = partsOf(r.commandId);
    await projector().handle(original[0]);
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
    await expect(outbox().reserve(r)).rejects.toThrow(
      "known command incomplete",
    );
    await expect(
      outbox().reserve({ ...r, actor: "admin:other" }),
    ).rejects.toThrow("known command incomplete");
    for (const part of original.slice(1)) await projector().handle(part);
    await expect(
      outbox().reserve({ ...r, actor: "admin:other" }),
    ).rejects.toThrow("id conflict");
    await expect(
      outbox().reserve({ ...r, data: { changed: true } }),
    ).rejects.toThrow("id conflict");
    expect(await outbox().reserve(r)).toBe(r.commandId);
    await outbox().deliver(r.commandId);
    expect(partsOf(r.commandId)).toEqual(original);
    for (const part of original) await projector().handle(part);
    expect(await effects(id)).toHaveLength(1);
    const next = input(id);
    await outbox().reserve(next);
    await outbox().deliver(next.commandId);
    expect(partsOf(next.commandId)[0].sequence).toBe(2);
  });
  test("startup catchup and unresolved durable partial delivery fence allocation after operational cache loss", async () => {
    const id = caseId();
    const r = input(id);
    const notReady = new RegulationCommandOutbox(
      connection.db,
      emit,
      async () => {
        throw Error("not caught up");
      },
    );
    await expect(notReady.reserve(r)).rejects.toThrow("not caught up");
    await outbox().reserve(r);
    await outbox().deliver(r.commandId);
    const parts = partsOf(r.commandId);
    expect(parts.length).toBeGreaterThan(1);
    await projector().handle(parts[0]);
    await connection.db
      .delete(schema.regulationCommandDeliveries)
      .where(eq(schema.regulationCommandDeliveries.caseId, id));
    await expect(outbox().reserve(input(id))).rejects.toThrow("unreconciled");
    for (const part of parts.slice(1)) await projector().handle(part);
    const next = input(id);
    await outbox().reserve(next);
    await outbox().deliver(next.commandId);
    expect(partsOf(next.commandId)[0].sequence).toBe(2);
  });
  test("conflicting header/payload or checksum cannot poison a valid sequence; concurrent final-part redelivery applies once", async () => {
    const id = caseId();
    const r = input(id);
    await outbox().reserve(r);
    await outbox().deliver(r.commandId);
    const parts = partsOf(r.commandId);
    await expect(
      projector().handle({
        ...parts[0],
        part: { ...parts[0].part, data: "corrupt" },
      }),
    ).rejects.toThrow();
    const headers = await connection.db
      .select()
      .from(schema.regulationCommandEnvelopes)
      .where(eq(schema.regulationCommandEnvelopes.caseId, id));
    expect(headers).toHaveLength(0);
    await projector().handle(parts[0]);
    const alien = { ...parts[0], sequence: 2 };
    const conflict = await projector().handle(alien);
    expect(conflict).toMatchObject({
      status: "quarantined",
      reason: "conflicting command order header",
    });
    expect(await projector().handle(alien)).toEqual(conflict);
    const alienId = {
      ...parts[0],
      part: { ...parts[0].part, assemblyId: randomUUID() },
    };
    const sequenceConflict = await projector().handle(alienId);
    expect(sequenceConflict).toMatchObject({
      status: "quarantined",
      reason: "conflicting command sequence",
    });
    const evidence = await connection.db
      .select()
      .from(schema.regulationImmutableConflicts)
      .where(eq(schema.regulationImmutableConflicts.caseId, id));
    expect(evidence).toHaveLength(2);
    expect(evidence.find((c) => c.kind === "command-header")?.received).toEqual(
      alien,
    );
    await connection.db
      .delete(schema.regulationImmutableConflicts)
      .where(eq(schema.regulationImmutableConflicts.caseId, id));
    expect(await projector().handle(alien)).toEqual(conflict);
    expect(await projector().handle(alienId)).toEqual(sequenceConflict);
    for (const part of parts.slice(1, -1)) await projector().handle(part);
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, () => projector().handle(parts.at(-1))),
    );
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await effects(id)).toHaveLength(1);
  });
  test("application crash rolls back domain, ordering tail and final assembly; delayed domain dependency remains pending instead of stale", async () => {
    const id = caseId();
    const r = input(id);
    await outbox().reserve(r);
    await outbox().deliver(r.commandId);
    const parts = partsOf(r.commandId);
    let mode: "crash" | "pending" | "apply" = "crash";
    const handler: OrderedCommandApplication = async (tx, c) => {
      if (mode === "pending")
        return { status: "pending", reason: "base not projected" };
      const result = await apply(tx, c);
      if (mode === "crash") throw Error("application crash");
      return result;
    };
    for (const part of parts.slice(0, -1))
      await projector(handler).handle(part);
    await expect(projector(handler).handle(parts.at(-1))).rejects.toThrow(
      "application crash",
    );
    expect(await effects(id)).toHaveLength(0);
    const tails = await connection.db
      .select()
      .from(schema.regulationCommandTails)
      .where(eq(schema.regulationCommandTails.caseId, id));
    expect(tails).toHaveLength(0);
    mode = "pending";
    expect(await projector(handler).handle(parts.at(-1))).toMatchObject({
      status: "pending",
    });
    mode = "apply";
    expect(await projector(handler).resume(r.commandId)).toEqual({
      status: "applied",
    });
    expect(await effects(id)).toHaveLength(1);
  });
  test.each([true, false])(
    "restoring later delivery cannot clear earlier replay prefix (earlier header observed=%s)",
    async (observedEarlier) => {
      const id = caseId();
      const a = input(id);
      const b = input(id);
      const c = input(id);
      const d = input(id);
      for (const command of [a, b]) {
        await outbox().reserve(command);
        await outbox().deliver(command.commandId);
      }
      const originalA = partsOf(a.commandId);
      const originalB = partsOf(b.commandId);
      expect(originalA.length).toBeGreaterThan(1);
      if (observedEarlier) await projector().handle(originalA[0]);
      for (const part of originalB) await projector().handle(part);
      await connection.db
        .delete(schema.regulationCommandDeliveries)
        .where(eq(schema.regulationCommandDeliveries.caseId, id));
      await expect(outbox().reserve(c)).rejects.toThrow("unreconciled");
      expect(await outbox().reserve(b)).toBe(b.commandId);
      await outbox().deliver(b.commandId);
      expect(partsOf(b.commandId)).toEqual(originalB);
      const attempts = await Promise.allSettled([
        outbox().reserve(c),
        outbox().reserve(d),
      ]);
      expect(
        attempts.every(
          (r) =>
            r.status === "rejected" &&
            r.reason instanceof Error &&
            r.reason.message.includes("unreconciled"),
        ),
      ).toBe(true);
      expect(await effects(id)).toHaveLength(0);
      // Re-instance and cache loss do not erase the persistent earlier fence.
      await connection.db
        .delete(schema.regulationCommandDeliveries)
        .where(eq(schema.regulationCommandDeliveries.caseId, id));
      await outbox().reserve(b);
      await outbox().deliver(b.commandId);
      await expect(outbox().reserve(c)).rejects.toThrow("unreconciled");
      // Arrival of the exact original predecessor bytes drains both commands.
      for (const part of originalA) await projector().handle(part);
      expect(await effects(id)).toHaveLength(2);
      await connection.db
        .delete(schema.regulationCommandDeliveries)
        .where(eq(schema.regulationCommandDeliveries.caseId, id));
      expect(await outbox().reserve(c)).toBe(c.commandId);
      await outbox().deliver(c.commandId);
      expect(partsOf(c.commandId)[0]).toMatchObject({
        sequence: 3,
        predecessorCommandId: b.commandId,
      });
    },
    5000,
  );
});

test("failed oldest delivery cannot starve a healthy case beyond the recovery window", async () => {
  const bad = {
    ...input(caseId()),
    commandId: "00000000-0000-4000-8000-000000000001",
  };
  const good = {
    ...input(caseId()),
    commandId: "00000000-0000-4000-8000-000000000002",
  };
  const delivered: string[] = [];
  const isolated = new RegulationCommandOutbox(
    connection.db,
    async (parts) => {
      const id = parts[0].part.assemblyId;
      if (id === bad.commandId) throw new Error("one case network outage");
      delivered.push(id);
      return { eventIds: parts.map(() => randomUUID()) };
    },
    caughtup,
  );
  await isolated.reserve(bad);
  await isolated.reserve(good);
  await expect(isolated.recover(1)).rejects.toThrow(
    "deliveries remain unconfirmed",
  );
  await isolated.recover(1);
  expect(delivered).toEqual([good.commandId]);
  expect(await effects(good.caseId)).toHaveLength(0);
  // Keep subsequent recovery tests isolated while retaining the failed receipt.
  await connection.client`update regulation_command_deliveries set status='acknowledged' where command_id=${bad.commandId}`;
}, 30000);

test("header/body sequence conflict is terminal and quarantined; a different case still projects", async () => {
  emissionMode = "success";
  const bad = input(caseId());
  await outbox().reserve(bad);
  await outbox().deliver(bad.commandId);
  const original = partsOf(bad.commandId);
  const body = reconstructSnapshot(
    manifestOf(original[0].part),
    original.map((p) => p.part),
  ) as Record<string, unknown>;
  const wrongBody = { ...body, sequence: 2 };
  const bytes = splitSnapshot(
    {
      assemblyId: bad.commandId,
      caseId: bad.caseId,
      baseRevisionId: bad.baseRevisionId,
      revisionId: bad.revisionId,
    },
    wrongBody,
  );
  const handler = projector();
  let result: unknown;
  for (const part of bytes)
    result = await handler.handle({
      schemaVersion: 1,
      sequence: 1,
      predecessorCommandId: null,
      part,
    });
  expect(result).toMatchObject({
    status: "refused",
    reason: "command header/body mismatch",
  });
  expect(await effects(bad.caseId)).toHaveLength(0);
  const [quarantine] =
    await connection.client`select reason from regulation_immutable_conflicts where case_id=${bad.caseId}`;
  expect(quarantine.reason).toBe("command header/body mismatch");
  const good = input(caseId());
  await outbox().reserve(good);
  await outbox().deliver(good.commandId);
  for (const part of partsOf(good.commandId)) await handler.handle(part);
  expect(await effects(good.caseId)).toHaveLength(1);
}, 30000);
