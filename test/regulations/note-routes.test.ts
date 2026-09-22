import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type { RegulationCaseNoteRecorded } from "../../src/events/contracts";
import type { PathwayWriter } from "../../src/pathways";
import type { RegulationQueueReadRepository } from "../../src/regulations/read-repository";
import { createRegulationsRouter } from "../../src/regulations/routes";

/**
 * What the note route does once the event is DURABLE — the one thing the
 * black-box suite cannot stage, because it needs the read-back to fail on a
 * write that succeeded. `noteId` is minted per request, so answering that
 * with an error invites the client to retry and write the note twice.
 */

function userOf(username: string, authorities: string[]): AuthContext {
  return {
    token: "t",
    user: {
      id: 1,
      username,
      firstName: "Test",
      lastName: "User",
      groupId: 1,
      groupName: null,
      authorities,
      fleets: [],
      serviceProvidersId: [],
      newsId: [],
      eventsId: [],
    },
  };
}

const TOKENS: Record<string, AuthContext> = {
  "admin-token": userOf("gilli", ["ADMIN", "USER"]),
};

const CASE_ID = "b52ba6c8-2ee0-8f9a-8bd7-6a4d29e0f7c3";
const CASE_KEY = "test-source:test-ban";

function makeApp(
  opts: {
    writeError?: Error;
    readBackError?: Error;
    readBackMisses?: boolean;
  } = {},
) {
  const written: RegulationCaseNoteRecorded[] = [];
  const writer = {
    writeRegulationCaseNoteRecorded: async (
      data: RegulationCaseNoteRecorded,
    ) => {
      if (opts.writeError) throw opts.writeError;
      written.push(data);
      return "event-789";
    },
  } as unknown as PathwayWriter;
  const queue = {
    getCaseRef: async (caseId: string) =>
      caseId === CASE_ID ? { id: CASE_ID, caseKey: CASE_KEY } : null,
    getCaseNote: async (noteId: string) => {
      if (opts.readBackError) throw opts.readBackError;
      if (opts.readBackMisses) return null;
      const note = written.find((entry) => entry.noteId === noteId);
      return note
        ? {
            ...note,
            recordedAt: new Date(note.recordedAt),
            createdAt: new Date(),
          }
        : null;
    },
  } as unknown as RegulationQueueReadRepository;
  const app = new Hono();
  app.use("/api/regulations/*", async (c, next) => {
    const auth = TOKENS[c.req.header("x-auth-token") ?? ""];
    if (!auth) return c.json({ error: "missing_auth_token" }, 401);
    c.set("auth", auth);
    return next();
  });
  app.route(
    "/api/regulations",
    createRegulationsRouter({
      queue,
      writer,
      groups: { getById: async () => null } as never,
      poi: { list: async () => [] } as never,
      jobRunner: {
        startJob: async () => ({ promise: Promise.resolve() }),
      } as never,
    }),
  );
  return { app, written };
}

function postNote(app: Hono, text: string) {
  return app.request(`/api/regulations/cases/${CASE_ID}/notes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-auth-token": "admin-token",
    },
    body: JSON.stringify({ text }),
  });
}

describe("POST /api/regulations/cases/:id/notes", () => {
  test("answers 201 with the projected row", async () => {
    const { app, written } = makeApp();
    const response = await postNote(app, "check with Vørn");
    expect(response.status).toBe(201);
    const body = (await response.json()) as { note: { text: string } };
    expect(body.note.text).toBe("check with Vørn");
    expect(written[0]?.actor).toBe("admin:gilli");
  });

  test("a failed WRITE is a 502 — nothing was recorded", async () => {
    const { app, written } = makeApp({
      writeError: new Error("flowcore down"),
    });
    const response = await postNote(app, "check with Vørn");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "flowcore_write_failed",
    });
    expect(written).toHaveLength(0);
  });

  test("a failed READ-BACK is a 202, never a 502 — the note is recorded", async () => {
    const { app, written } = makeApp({ readBackError: new Error("db down") });
    const response = await postNote(app, "check with Vørn");
    // The distinction that matters: a 502 here would invite a retry, and
    // the retried request mints a NEW noteId — two notes for one intent.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      noteId: written[0]?.noteId as string,
      eventId: "event-789",
      recordedAt: written[0]?.recordedAt as string,
    });
    expect(written).toHaveLength(1);
  });

  test("a projection that has not landed yet is the same 202", async () => {
    const { app, written } = makeApp({ readBackMisses: true });
    const response = await postNote(app, "check with Vørn");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      noteId: written[0]?.noteId as string,
      eventId: "event-789",
      recordedAt: written[0]?.recordedAt as string,
    });
  });
});
