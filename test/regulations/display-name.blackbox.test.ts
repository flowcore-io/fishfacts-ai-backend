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
const ADMIN_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const DECKHAND_TOKEN = "2c2f0b4e-98b2-4a3f-9c6f-2e2f8a55aa01";
const ANNOUNCEMENT_FLOW = "fishfacts-announcement.0";
const ANNOUNCEMENT_EVENT = "jmelding.announcement.discovered.0";
const REGULATION_FLOW = "fishfacts-regulation-queue.0";
/** A syntactically valid case id that is not in the database. */
const UNKNOWN_CASE_ID = "a1b2c3d4-1111-4111-8111-1111deadbeef";

/**
 * The statute the whole feature exists for: a title no popup can head with.
 * Seeded as a Norwegian J-melding so its case key is predictable, and keyed
 * `dn-` so this suite can clear its OWN rows instead of truncating tables a
 * concurrently developed suite also seeds.
 */
const CASE_KEY_PREFIX = "dn-";
const JM_NUMBER = "dn-01-2026";
const OFFICIAL_TITLE =
  "Kunngerð nr. 232 frá 30. desember 2025 um at skipa fiskiskapin hjá skipum undir norskum flaggi í føroyskum sjógvi í 2026";
const AMENDED_TITLE = `${OFFICIAL_TITLE} (broytt 1. mars 2026)`;
const BODY = "Tað er forboðið at fiska við botntroli í økinum.";
const FIRST_NAME = "Norwegian-flag vessels 2026";
const SECOND_NAME = "Norsk-flagg 2026";

const usable = new FakeUsableServer(USABLE_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
const webhook = new WebhookTestFixture({
  port: WEBHOOK_PORT,
  secret: TRANSFORMER_SECRET,
  transformerUrl: `http://127.0.0.1:${APP_PORT}/api/transformer`,
})
  .addEndpoint(ANNOUNCEMENT_FLOW, ANNOUNCEMENT_EVENT, true)
  .addEndpoint(REGULATION_FLOW, "regulation.case.revision.proposed.0", true)
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

type RevisionFields = Record<string, unknown> & {
  title?: string;
  displayName?: string | null;
};

type Revision = {
  id: string;
  author: string;
  isCurrent: boolean;
  changes: Array<{ field: string; justification: string }> | null;
  fields: RevisionFields | null;
};

type CaseDetail = {
  case: {
    id: string;
    caseKey: string;
    title: string;
    adminStatus: string;
    currentRevisionId: string;
    regulatoryValidated: boolean;
  };
  revisions: Revision[];
};

type Published = {
  id: string;
  title: string;
  displayName: string | null;
  regulationNumber: string | null;
  publishedRevisionId: string;
};

/** The case under test, resolved once the announcement has been projected. */
let caseId = "";

async function adminFetch(path: string, init: RequestInit = {}) {
  return await app.fetch(path, {
    ...init,
    headers: { "x-auth-token": ADMIN_TOKEN, ...init.headers },
  });
}

/** Deliver one announcement the way the collectors do — a real envelope
 * through the app's transformer, so the real case projector runs. */
async function seedAnnouncement(seed: { signature: string; title: string }) {
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
        signature: seed.signature,
        title: seed.title,
        url: `http://127.0.0.1:${WEBHOOK_PORT}/regs/${JM_NUMBER}`,
        status: "current",
        jmNumber: JM_NUMBER,
        region: "NO",
        bodyMarkdown: BODY,
        contentHash: `hash-${seed.signature}`,
        checkedAt: new Date().toISOString(),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `seeding ${seed.signature} failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function caseIdOf(): Promise<string> {
  const response = await adminFetch("/api/regulations/queue?limit=200");
  const body = (await response.json()) as {
    cases: Array<{ id: string; caseKey: string }>;
  };
  const match = body.cases.find((entry) =>
    entry.caseKey.endsWith(`:${JM_NUMBER}`),
  );
  if (!match) throw new Error(`case ${JM_NUMBER} was not projected`);
  return match.id;
}

async function caseDetail(): Promise<CaseDetail> {
  const response = await adminFetch(`/api/regulations/cases/${caseId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as CaseDetail;
}

async function currentFields(): Promise<RevisionFields> {
  const detail = await caseDetail();
  const current = detail.revisions.find((revision) => revision.isCurrent);
  if (!current?.fields) throw new Error("the current revision has no fields");
  return current.fields;
}

/** The non-admin read a skipper's map and the 1st mate go through. */
async function publishedRead(): Promise<Published | null> {
  const response = await app.fetch(`/api/regulations/published/${caseId}`, {
    headers: { "x-auth-token": DECKHAND_TOKEN },
  });
  if (response.status === 404) return null;
  expect(response.status).toBe(200);
  return (await response.json()) as Published;
}

async function proposeDisplayName(
  displayName: string | null,
  justification: string,
): Promise<Response> {
  const detail = await caseDetail();
  const fields = await currentFields();
  return await adminFetch(`/api/regulations/cases/${caseId}/revisions`, {
    method: "POST",
    body: JSON.stringify({
      baseRevisionId: detail.case.currentRevisionId,
      fields: { ...fields, displayName },
      justifications: { displayName: justification },
    }),
  });
}

/** Validate legally and approve metadata-only — the whole ceremony for a
 * case with no drawn areas, and what moves the published pin. */
async function validateAndApprove(revisionId: string): Promise<void> {
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
    const detail = await caseDetail();
    return detail.case.regulatoryValidated;
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
    const published = await publishedRead();
    return published?.publishedRevisionId === revisionId;
  }, "the approval never pinned the revision");
}

async function waitFor<T>(
  read: () => Promise<T | null | undefined | false>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as T;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

/** Wait for a landed proposal to become the current revision. */
async function waitForCurrentRevision(revisionId: string): Promise<CaseDetail> {
  return await waitFor(async () => {
    const detail = await caseDetail();
    return detail.case.currentRevisionId === revisionId ? detail : null;
  }, `the revision ${revisionId} never landed`);
}

describe("regulation display name black-box", () => {
  beforeAll(async () => {
    await usable.start();
    await fishfacts.start();
    fishfacts.addValidToken(ADMIN_TOKEN, {
      authorities: ["FISHFACTS", "USER", "ADMIN"],
    });
    fishfacts.addValidToken(DECKHAND_TOKEN, {
      username: "deckhand",
      authorities: ["FISHFACTS", "USER"],
    });
    await webhook.start();
    // Only this suite's own case is cleared — other regulation suites seed
    // into the same database, and truncating would pull the rug from under
    // them.
    const mine = `%:${CASE_KEY_PREFIX}%`;
    for (const table of [
      "regulation_case_geometries",
      "regulation_case_revisions",
      "regulation_case_sources",
      "regulation_case_links",
      "regulation_case_actions",
      "regulation_case_validations",
      "regulation_case_approvals",
    ]) {
      await db`delete from ${db(table)} where case_id in (
        select id from regulation_cases where case_key like ${mine}
      )`;
    }
    await db`delete from regulation_cases where case_key like ${mine}`;
    await app.start();

    await seedAnnouncement({
      signature: `display-name-${JM_NUMBER}-v1`,
      title: OFFICIAL_TITLE,
    });
    caseId = await caseIdOf();
    const detail = await caseDetail();
    await validateAndApprove(detail.case.currentRevisionId);
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await fishfacts.stop();
    await usable.stop();
    await db.end();
  });

  test("a published regulation without a display name reads as null", async () => {
    const published = await publishedRead();
    expect(published?.title).toBe(OFFICIAL_TITLE);
    expect(published?.displayName).toBeNull();
  });

  test("proposing a display name changes that field and nothing else, and puts the case back under review", async () => {
    const before = await currentFields();
    const proposed = await proposeDisplayName(
      FIRST_NAME,
      "Statute title is four lines; skippers need a name they can read.",
    );
    expect(proposed.status).toBe(202);
    const { revisionId } = (await proposed.json()) as { revisionId: string };
    const detail = await waitForCurrentRevision(revisionId);

    const revision = detail.revisions.find((entry) => entry.id === revisionId);
    expect(revision?.changes).toHaveLength(1);
    expect(revision?.changes?.[0]?.field).toBe("displayName");
    expect(revision?.changes?.[0]?.justification).toContain("four lines");
    expect(revision?.author).toContain("admin:");
    expect(revision?.fields?.displayName).toBe(FIRST_NAME);
    // The official title is untouched, and so is every other field.
    expect(revision?.fields?.title).toBe(OFFICIAL_TITLE);
    const withoutDisplayName = (fields: RevisionFields | null | undefined) => {
      const { displayName: _ignored, ...rest } = fields ?? {};
      return rest;
    };
    expect(withoutDisplayName(revision?.fields)).toEqual(
      withoutDisplayName(before),
    );
    // A rename un-approves the case, exactly like any other edit.
    expect(detail.case.adminStatus).toBe("under_review");
  });

  test("users keep seeing the old name until the rename is approved", async () => {
    const pending = await publishedRead();
    expect(pending?.displayName).toBeNull();
    expect(pending?.title).toBe(OFFICIAL_TITLE);

    const detail = await caseDetail();
    await validateAndApprove(detail.case.currentRevisionId);

    const published = await publishedRead();
    expect(published?.displayName).toBe(FIRST_NAME);
    // The legal reference is what it always was.
    expect(published?.title).toBe(OFFICIAL_TITLE);
    expect(published?.regulationNumber).toBe(
      detail.revisions.find((entry) => entry.isCurrent)?.fields
        ?.regulationNumber as string | null,
    );

    // And a SECOND rename is invisible until it too is approved: the
    // published read serves the pinned revision, never the draft.
    const proposed = await proposeDisplayName(
      SECOND_NAME,
      "Shorter still; the popup heading wraps on a phone.",
    );
    expect(proposed.status).toBe(202);
    const { revisionId } = (await proposed.json()) as { revisionId: string };
    await waitForCurrentRevision(revisionId);
    expect((await publishedRead())?.displayName).toBe(FIRST_NAME);

    await validateAndApprove(revisionId);
    expect((await publishedRead())?.displayName).toBe(SECOND_NAME);
  });

  test("the corpus fragment the 1st mate retrieves keeps the official title", async () => {
    const published = await publishedRead();
    const fragment = await waitFor(async () => {
      return (
        Array.from(usable.fragments.values()).find(
          (entry) =>
            entry.key?.endsWith(JM_NUMBER) &&
            entry.content.includes(
              `revisionId: ${published?.publishedRevisionId}`,
            ),
        ) ?? null
      );
    }, "the published-corpus fragment was never synced");

    expect(fragment.title).toBe(OFFICIAL_TITLE);
    expect(fragment.content).toContain(`# ${OFFICIAL_TITLE}`);
    // The short name is an admin's label for a UI heading — it is not what
    // an answer cites, so it never reaches the retrieval corpus.
    expect(fragment.content).not.toContain(SECOND_NAME);
    expect(fragment.title).not.toContain(SECOND_NAME);
  });

  test("an amended source text keeps the display name the admin set", async () => {
    await seedAnnouncement({
      signature: `display-name-${JM_NUMBER}-v2`,
      title: AMENDED_TITLE,
    });
    const detail = await waitFor(async () => {
      const current = await caseDetail();
      const revision = current.revisions.find((entry) => entry.isCurrent);
      return revision?.fields?.title === AMENDED_TITLE ? current : null;
    }, "the amendment never landed");

    const revision = detail.revisions.find((entry) => entry.isCurrent);
    expect(revision?.author).toContain("collector:");
    expect(revision?.fields?.title).toBe(AMENDED_TITLE);
    expect(revision?.fields?.displayName).toBe(SECOND_NAME);
    // The pin has not moved, so users still read the approved revision.
    expect((await publishedRead())?.title).toBe(OFFICIAL_TITLE);
  });

  test("a blank, an over-long and an unexplained display name are all refused, and so is a deckhand", async () => {
    const detail = await caseDetail();
    const fields = await currentFields();
    const post = (body: unknown, token = ADMIN_TOKEN) =>
      app.fetch(`/api/regulations/cases/${caseId}/revisions`, {
        method: "POST",
        headers: { "x-auth-token": token },
        body: JSON.stringify(body),
      });

    const blank = await post({
      baseRevisionId: detail.case.currentRevisionId,
      fields: { ...fields, displayName: "   " },
      justifications: { displayName: "blank" },
    });
    expect(blank.status).toBe(400);

    const tooLong = await post({
      baseRevisionId: detail.case.currentRevisionId,
      fields: { ...fields, displayName: "x".repeat(121) },
      justifications: { displayName: "too long" },
    });
    expect(tooLong.status).toBe(400);

    const unexplained = await post({
      baseRevisionId: detail.case.currentRevisionId,
      fields: { ...fields, displayName: "Unexplained rename" },
      justifications: {},
    });
    expect(unexplained.status).toBe(400);
    expect((await unexplained.json()) as { fields?: string[] }).toMatchObject({
      fields: ["displayName"],
    });

    // Naming a base revision that is no longer current is the
    // edit-after-source-change race, refused with the diff.
    const stale = await post({
      baseRevisionId: UNKNOWN_CASE_ID,
      fields: { ...fields, displayName: "Raced rename" },
      justifications: { displayName: "raced" },
    });
    expect(stale.status).toBe(409);

    const deckhand = await post(
      {
        baseRevisionId: detail.case.currentRevisionId,
        fields: { ...fields, displayName: "Not an admin" },
        justifications: { displayName: "nope" },
      },
      DECKHAND_TOKEN,
    );
    expect(deckhand.status).toBe(403);

    // Nothing above landed: the case is exactly where it was.
    const after = await caseDetail();
    expect(after.case.currentRevisionId).toBe(detail.case.currentRevisionId);
    expect(after.revisions).toHaveLength(detail.revisions.length);
  });
});
