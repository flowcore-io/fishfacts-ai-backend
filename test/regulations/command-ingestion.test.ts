import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CommandPart } from "../../src/events/regulation-case-command";
import { splitSnapshot } from "../../src/events/regulation-snapshot-parts";
import { createCommandIngestion } from "../../src/regulations/command-ingestion";
const env = {
  FLOWCORE_API_URL: "http://127.0.0.1:1",
  FLOWCORE_TENANT: "fixture",
  FLOWCORE_DATA_CORE: "fixture",
  FLOWCORE_API_KEY: "fc_local_fixture",
};
test("abortable local ingestion preserves every exact UTF8 byte part and validates complete receipts for a measured-size payload", async () => {
  const commandId = randomUUID();
  const caseId = randomUUID();
  const revisionId = randomUUID();
  const payload = {
    commandId,
    caseId,
    revisionId,
    body: "Øst😀".repeat(600000),
  };
  const parts: CommandPart[] = splitSnapshot(
    { assemblyId: commandId, caseId, baseRevisionId: revisionId, revisionId },
    payload,
  ).map((part) => ({
    schemaVersion: 1,
    sequence: 1,
    predecessorCommandId: null,
    part,
  }));
  const received: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("Authorization")).toBe(env.FLOWCORE_API_KEY);
      const data = await request.json();
      const batch = Array.isArray(data) ? data : [data];
      received.push(...batch);
      return Response.json(
        Array.isArray(data)
          ? { eventIds: batch.map(() => randomUUID()) }
          : { eventId: randomUUID() },
      );
    },
  });
  try {
    const started = performance.now();
    const result = await createCommandIngestion({
      ...env,
      FLOWCORE_API_URL: `http://127.0.0.1:${server.port}`,
    }).emit(parts);
    expect(result.eventIds).toHaveLength(parts.length);
    expect(received).toEqual(parts);
    expect(parts.length).toBeGreaterThan(100);
    expect(
      Math.max(...parts.map((p) => Buffer.byteLength(JSON.stringify(p)))),
    ).toBeLessThan(64000);
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    await server.stop(true);
  }
}, 10000);
test("unconfirmed receipt, HTTP failure and aborted network never acknowledge or silently retry a new command", async () => {
  for (const response of [
    Response.json({ eventIds: [] }),
    Response.json({ success: false, eventId: "alien" }),
    new Response("failure", { status: 503 }),
  ]) {
    const sender = (async () => response) as unknown as typeof fetch;
    await expect(
      createCommandIngestion(env, sender).ingest("fixture", [{ a: 1 }]),
    ).rejects.toThrow("unconfirmed");
  }
  let calls = 0;
  const sender = (async (
    _url: Parameters<typeof fetch>[0],
    options: RequestInit | undefined,
  ) => {
    calls++;
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason),
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
  const started = performance.now();
  await expect(
    createCommandIngestion(env, sender, 25).ingest("fixture", [{ a: 1 }]),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(performance.now() - started).toBeLessThan(500);
}, 1000);
