import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

const APP_PORT = 4480;
const USABLE_PORT = 4481;
const FISHFACTS_PORT = 4482;
const WEBHOOK_PORT = 4483;
const DB_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";
const TRANSFORMER_SECRET = "test-transformer-secret";
const ADMIN_TOKEN = "6d6b3f2e-6f4a-4a1b-9a8f-7c4d2b1a9e01";
const SECOND_ADMIN_TOKEN = "6d6b3f2e-6f4a-4a1b-9a8f-7c4d2b1a9e02";
const DECKHAND_TOKEN = "6d6b3f2e-6f4a-4a1b-9a8f-7c4d2b1a9e03";
const ADMIN_USERNAME = "anna";
const SECOND_ADMIN_USERNAME = "gilli";
const ANNOUNCEMENT_FLOW = "fishfacts-announcement.0";
const ANNOUNCEMENT_EVENT = "jmelding.announcement.discovered.0";
const REGULATION_FLOW = "fishfacts-regulation-queue.0";
/** A syntactically valid case id that is not in the database. */
const UNKNOWN_CASE_ID = "a1b2c3d4-2222-4222-8222-2222deadbeef";

/**
 * The note text S2 hunts for. Unique enough that finding it anywhere in a
 * published body or a corpus fragment can only mean the note leaked.
 */
const SENTINEL = "NOTE-SENTINEL-ee2f1a7c-check-with-Vorn-about-3";

/** One case per scenario: the assertions here are about what a note does and
 * does NOT touch, so no two of them may share a case. */
const CASES = {
  plain: {
    jmNumber: "j-95-2026",
    region: "NO",
    title: "J-95-2026 Stenging av område utenfor Røstbanken",
    body: "Det er forbudt å fiske med torsketrål i det stengte området.",
  },
  published: {
    jmNumber: "j-96-2026",
    region: "NO",
    title: "J-96-2026 Forbud mot fiske med snurrevad",
    body: "Det er forbudt å fiske med snurrevad i det stengte området.",
  },
  shared: {
    jmNumber: "j-97-2026",
    region: "FO",
    title: "Veiðibann á Sandoyarbanka",
    body: "Tað er bannað at fiska við botntroli á økinum.",
  },
  amended: {
    jmNumber: "j-98-2026",
    region: "NO",
    title: "J-98-2026 Stenging av område i Barentshavet",
    body: "Det er forbudt å fiske med snurrevad i det stengte området.",
  },
} as const;

const usable = new FakeUsableServer(USABLE_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
const webhook = new WebhookTestFixture({
  port: WEBHOOK_PORT,
  secret: TRANSFORMER_SECRET,
  transformerUrl: `http://127.0.0.1:${APP_PORT}/api/transformer`,
})
  .addEndpoint(ANNOUNCEMENT_FLOW, ANNOUNCEMENT_EVENT, true)
  .addEndpoint(REGULATION_FLOW, "regulation.case.note.recorded.0", true)
  .addEndpoint(REGULATION_FLOW, "regulation.case.validation.recorded.0", true)
  .addEndpoint(REGULATION_FLOW, "regulation.case.approval.recorded.0", true);
const app = new AppProcess(APP_PORT, {
  NODE_ENV: "test",
  DATABASE_URL: DB_URL,
  FLOWCORE_TENANT: "jbiskur",
  FLOWCORE_DATA_CORE: "fishfacts-ai-backend",
  FLOWCORE_DATA_CORE_ID: "ad37e770-4d43-4ebd-8166-401be5e0b513",
  FLOWCORE_API_URL: `http://127.0.0.1:${WEBHOOK_PORT}`,
  FLOWCORE_API_KEY: "fc_test_fixture_key",
  FLOWCORE_TRANSFORMER_SECRET: TRANSFORMER_SECRET,
  PUMP_RESET_SECRET: "test-reset-secret",
  SERVICE_URL: `http://127.0.0.1:${APP_PORT}`,
  DISABLE_EVENT_STREAMING: "true",
  USABLE_WORKSPACE_ID: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
  USABLE_API_BASE_URL: usable.baseUrl,
  USABLE_API_TOKEN: "usable-test-token",
  USABLE_CHAT_EMBED_URL: `${usable.baseUrl}/embed-chat`,
  INGESTION_EMBED_KEY: "embed-test-key",
  JOB_SCHEDULER_ENABLED: "false",
  FISHFACTS_API_BASE_URL: fishfacts.baseUrl,
  FISHFACTS_APPLICATION: "FISHFACTS",
});

const db = postgres(DB_URL, { max: 1 });

type Note = {
  noteId: string;
  caseId: string;
  caseKey: string;
  text: string;
  actor: string;
  recordedAt: string;
};

type CaseDetail = {
  case: { caseKey: string; currentRevisionId: string };
  revisions: Array<{ id: string; isCurrent: boolean }>;
  notes: Note[];
};

function fetchAs(token: string) {
  return async (path: string, init: RequestInit = {}) =>
    await app.fetch(path, {
      ...init,
      headers: { "x-auth-token": token, ...init.headers },
    });
}

const adminFetch = fetchAs(ADMIN_TOKEN);
const secondAdminFetch = fetchAs(SECOND_ADMIN_TOKEN);
const deckhandFetch = fetchAs(DECKHAND_TOKEN);

async function seedCase(seed: {
  jmNumber: string;
  region: string;
  title: string;
  body: string;
  signatureSuffix?: string;
}) {
  const response = await app.fetch("/api/transformer", {
    method: "POST",
    headers: { "x-secret": TRANSFORMER_SECRET },
    body: JSON.stringify({
      eventId: crypto.randomUUID(),
      timeBucket: "20260101000000",
      tenant: "jbiskur",
      dataCoreId: "fishfacts-ai-backend",
      flowType: ANNOUNCEMENT_FLOW,
      eventType: ANNOUNCEMENT_EVENT,
      validTime: new Date().toISOString(),
      metadata: {},
      payload: {
        // The signature is the revision's identity: a second delivery under
        // a NEW signature is the collector amending the source (S4).
        signature: `notes-${seed.jmNumber}${seed.signatureSuffix ?? ""}`,
        title: seed.title,
        url: `http://127.0.0.1:${WEBHOOK_PORT}/regs/${seed.jmNumber}`,
        status: "current",
        jmNumber: seed.jmNumber,
        region: seed.region,
        bodyMarkdown: seed.body,
        contentHash: `hash-${seed.jmNumber}${seed.signatureSuffix ?? ""}`,
        checkedAt: new Date().toISOString(),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `seeding ${seed.jmNumber} failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function caseIdOf(jmNumber: string): Promise<string> {
  const response = await adminFetch("/api/regulations/queue?limit=200");
  const body = (await response.json()) as {
    cases: Array<{ id: string; caseKey: string }>;
  };
  const match = body.cases.find((entry) =>
    entry.caseKey.endsWith(`:${jmNumber}`),
  );
  if (!match) throw new Error(`case ${jmNumber} was not projected`);
  return match.id;
}

async function caseDetail(caseId: string): Promise<CaseDetail> {
  const response = await adminFetch(`/api/regulations/cases/${caseId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as CaseDetail;
}

async function addNote(
  request: ReturnType<typeof fetchAs>,
  caseId: string,
  text: string,
): Promise<Note> {
  const response = await request(`/api/regulations/cases/${caseId}/notes`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { note: Note };
  return body.note;
}

async function waitFor<T>(
  read: () => Promise<T | null | undefined | false>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as T;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

/** Legal validation + a metadata-only approval — the whole publish ceremony
 * for a case with no drawn areas. */
async function publish(caseId: string, revisionId: string) {
  const validated = await adminFetch(
    `/api/regulations/cases/${caseId}/validations`,
    {
      method: "POST",
      body: JSON.stringify({
        revisionId,
        scope: "legal",
        validated: true,
        note: "reviewed",
      }),
    },
  );
  expect(validated.status).toBe(202);
  await waitFor(async () => {
    const rows =
      await db`select regulatory_validated from regulation_cases where id = ${caseId}`;
    return rows[0]?.regulatory_validated === true;
  }, "the validation never landed");
  const approved = await adminFetch(
    `/api/regulations/cases/${caseId}/approval`,
    {
      method: "POST",
      body: JSON.stringify({ revisionId, metadataOnly: true, note: "ok" }),
    },
  );
  expect(approved.status).toBe(202);
  await waitFor(async () => {
    const rows =
      await db`select published_revision_id from regulation_cases where id = ${caseId}`;
    return rows[0]?.published_revision_id === revisionId;
  }, "the approval never pinned the revision");
}

describe("regulation case notes black-box", () => {
  beforeAll(async () => {
    await usable.start();
    await fishfacts.start();
    fishfacts.addValidToken(ADMIN_TOKEN, {
      username: ADMIN_USERNAME,
      authorities: ["FISHFACTS", "USER", "ADMIN"],
    });
    fishfacts.addValidToken(SECOND_ADMIN_TOKEN, {
      username: SECOND_ADMIN_USERNAME,
      authorities: ["FISHFACTS", "USER", "ADMIN"],
    });
    fishfacts.addValidToken(DECKHAND_TOKEN, {
      username: "deckhand",
      authorities: ["FISHFACTS", "USER"],
    });
    await webhook.start();
    // Started BEFORE the tables are cleared: the service applies its
    // journaled migrations at boot, so `regulation_case_notes` only exists
    // once it has run.
    await app.start();
    // This suite asserts on the published set and on note ordering, so it
    // owns the regulation tables.
    await db`truncate table regulation_cases, regulation_case_revisions, regulation_case_geometries, regulation_case_sources, regulation_case_links, regulation_case_actions, regulation_case_validations, regulation_case_approvals, regulation_case_notes`;
    await db`truncate table job_state, job_runs`;

    for (const seed of Object.values(CASES)) await seedCase(seed);
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await fishfacts.stop();
    await usable.stop();
    await db.end();
  });

  test("a note lands on the case and changes nothing else", async () => {
    const caseId = await caseIdOf(CASES.plain.jmNumber);
    const before = await caseDetail(caseId);
    expect(before.notes).toEqual([]);

    const note = await addNote(adminFetch, caseId, "  check with Vørn  ");
    // Trimmed on the way in: the stored note is the admin's words, not their
    // whitespace.
    expect(note.text).toBe("check with Vørn");
    expect(note.actor).toBe(`admin:${ADMIN_USERNAME}`);
    expect(note.caseId).toBe(caseId);
    expect(Date.parse(note.recordedAt)).toBeGreaterThan(Date.now() - 60000);

    const after = await caseDetail(caseId);
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0]).toMatchObject({
      noteId: note.noteId,
      text: "check with Vørn",
      actor: `admin:${ADMIN_USERNAME}`,
    });
    // The whole point: review state cannot move because someone wrote a
    // note. Everything the detail read serves, except `notes`, is identical.
    const withoutNotes = (detail: CaseDetail) => {
      const { notes: _ignored, ...rest } = detail;
      return rest;
    };
    expect(withoutNotes(after)).toEqual(withoutNotes(before));
  }, 30000);

  test("a note never leaves the admin surface", async () => {
    const caseId = await caseIdOf(CASES.published.jmNumber);
    const detail = await caseDetail(caseId);
    await addNote(adminFetch, caseId, SENTINEL);
    await publish(caseId, detail.case.currentRevisionId);

    const list = await adminFetch("/api/regulations/published?limit=50");
    expect(list.status).toBe(200);
    const listBody = await list.text();
    expect(listBody).toContain(detail.case.caseKey);
    expect(listBody).not.toContain(SENTINEL);

    const single = await adminFetch(`/api/regulations/published/${caseId}`);
    expect(single.status).toBe(200);
    expect(await single.text()).not.toContain(SENTINEL);

    // The corpus leg: the 1st mate retrieves the published fragment, so the
    // fragment body is where a leak would reach the assistant.
    const fragment = await waitFor(
      async () =>
        // Found by the case key the fragment states in its own frontmatter,
        // rather than by re-deriving the sanitized fragment key here.
        Array.from(usable.fragments.values()).find((entry) =>
          entry.content.includes(detail.case.caseKey),
        ),
      "the published fragment was never synced",
    );
    expect(fragment.content).not.toContain(SENTINEL);
    // …and nothing the sync SENT carried it either, fragment or not.
    expect(JSON.stringify(usable.calls)).not.toContain(SENTINEL);
  }, 60000);

  test("two authors, newest first, and nothing can change a note", async () => {
    const caseId = await caseIdOf(CASES.shared.jmNumber);
    const first = await addNote(adminFetch, caseId, "Gilli says this expired");
    // `recordedAt` is a server-clock millisecond, so two posts in the same
    // millisecond would fall to the noteId tie-break and their order would
    // be arbitrary — which is not what this test is about. A short wait
    // makes the two instants genuinely distinct, so "newest first" means
    // what it says.
    await Bun.sleep(5);
    const second = await addNote(
      secondAdminFetch,
      caseId,
      "Asked Vørn, awaiting an answer",
    );
    expect(second.recordedAt > first.recordedAt).toBe(true);

    const detail = await caseDetail(caseId);
    expect(detail.notes.map((note) => note.noteId)).toEqual([
      second.noteId,
      first.noteId,
    ]);
    expect(detail.notes.map((note) => note.actor)).toEqual([
      `admin:${SECOND_ADMIN_USERNAME}`,
      `admin:${ADMIN_USERNAME}`,
    ]);
    // Whatever the instants, the list is never out of order.
    const recorded = detail.notes.map((note) => Date.parse(note.recordedAt));
    expect(recorded).toEqual([...recorded].sort((a, b) => b - a));

    // Append-only is enforced by the ABSENCE of the verb, so the proof is
    // that no mutation route exists at all.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await adminFetch(
        `/api/regulations/cases/${caseId}/notes/${first.noteId}`,
        { method },
      );
      expect(response.status).toBe(404);
    }
    const collectionDelete = await adminFetch(
      `/api/regulations/cases/${caseId}/notes`,
      { method: "DELETE" },
    );
    expect(collectionDelete.status).toBe(404);
  }, 30000);

  test("a collector amendment carries the notes", async () => {
    const caseId = await caseIdOf(CASES.amended.jmNumber);
    const note = await addNote(adminFetch, caseId, "Check the new § 4 wording");
    const before = await caseDetail(caseId);
    expect(before.revisions).toHaveLength(1);

    await seedCase({
      ...CASES.amended,
      body: `${CASES.amended.body}\nForbudet gjelder ikke fartøy under 15 meter.`,
      signatureSuffix: "-amended",
    });
    const after = await waitFor(async () => {
      const detail = await caseDetail(caseId);
      return detail.revisions.length === 2 ? detail : null;
    }, "the amended source never landed a new revision");

    expect(after.revisions.at(-1)?.isCurrent).toBe(true);
    expect(after.notes.map((entry) => entry.noteId)).toEqual([note.noteId]);
    expect(after.notes[0]?.text).toBe("Check the new § 4 wording");
  }, 60000);

  test("empty, whitespace-only and over-long notes are refused by name", async () => {
    const caseId = await caseIdOf(CASES.plain.jmNumber);
    for (const text of ["", "   \n\t "]) {
      const response = await adminFetch(
        `/api/regulations/cases/${caseId}/notes`,
        { method: "POST", body: JSON.stringify({ text }) },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_payload",
        reason: "note_text_required",
      });
    }
    const tooLong = await adminFetch(`/api/regulations/cases/${caseId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(4001) }),
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({
      reason: "note_text_required",
    });
  }, 30000);

  test("a deckhand cannot note, and an unknown case is a 404", async () => {
    const caseId = await caseIdOf(CASES.plain.jmNumber);
    const forbidden = await deckhandFetch(
      `/api/regulations/cases/${caseId}/notes`,
      { method: "POST", body: JSON.stringify({ text: "let me in" }) },
    );
    expect(forbidden.status).toBe(403);

    const missing = await adminFetch(
      `/api/regulations/cases/${UNKNOWN_CASE_ID}/notes`,
      { method: "POST", body: JSON.stringify({ text: "nobody home" }) },
    );
    expect(missing.status).toBe(404);

    // The refused writes left nothing behind.
    const detail = await caseDetail(caseId);
    expect(detail.notes).toHaveLength(1);
  }, 30000);
});
