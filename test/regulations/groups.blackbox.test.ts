import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

const APP_PORT = 4500;
const USABLE_PORT = 4501;
const FISHFACTS_PORT = 4502;
const WEBHOOK_PORT = 4503;
const DB_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";
const TRANSFORMER_SECRET = "test-transformer-secret";
const ADMIN_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const DECKHAND_TOKEN = "2c2f0b4e-98b2-4a3f-9c6f-2e2f8a55aa01";
const ANNOUNCEMENT_FLOW = "fishfacts-announcement.0";
const ANNOUNCEMENT_EVENT = "jmelding.announcement.discovered.0";
const REGULATION_FLOW = "fishfacts-regulation-queue.0";
/** A syntactically valid uuid that names no group. */
const UNKNOWN_GROUP_ID = "a1b2c3d4-2222-4222-8222-2222deadbeef";

/**
 * Two Norwegian-flag statutes an admin would want under one heading. Keyed
 * `gp-` so this suite clears its OWN rows: other regulation suites seed into
 * the same database and truncating would pull the rug from under them.
 */
const CASE_KEY_PREFIX = "gp-";
const MEMBERS = [
  { jmNumber: "gp-01-2026", title: "Kunngerð nr. 228 frá 2025" },
  { jmNumber: "gp-02-2026", title: "Kunngerð nr. 231 frá 2025" },
];
const BODY = "Tað er forboðið at fiska við botntroli í økinum.";

/** Every group this suite creates carries the prefix, so cleanup can find
 * them without touching a concurrently developed suite's rows. */
const GROUP_PREFIX = "gp-test ";
const GROUP_NAME = `${GROUP_PREFIX}Foreign-flag fishing 2026`;
const GROUP_RENAMED = `${GROUP_PREFIX}Foreign flags 2026`;
const EMPTY_GROUP_NAME = `${GROUP_PREFIX}Nobody in here`;
const FOREIGN_GROUP_NAME = `${GROUP_PREFIX}Faroese waters`;

/** The jurisdiction the members live in (`region` on the announcement), and
 * a second country for the cross-jurisdiction refusal. */
const HOME = "NO";
const ABROAD = "FO";
/** What a Norwegian J-melding's default group is called — the FE's own
 * `SOURCE_TYPE_LABELS` entry for `fiskeridir-jmelding`. */
const DEFAULT_GROUP_NAME = "J-melding closures";
const DEFAULT_GROUP_ID = `default:${HOME}:fiskeridir-jmelding`;
/** Every default group sorts after every admin group. */
const DEFAULT_GROUP_SORT_FLOOR = 1000;

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
  .addEndpoint(REGULATION_FLOW, "regulation.case.approval.recorded.0", true)
  .addEndpoint(REGULATION_FLOW, "regulation.group.created.0", true)
  .addEndpoint(REGULATION_FLOW, "regulation.group.renamed.0", true)
  .addEndpoint(REGULATION_FLOW, "regulation.group.reordered.0", true)
  .addEndpoint(REGULATION_FLOW, "regulation.group.retired.0", true);
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

type RevisionFields = Record<string, unknown> & { groupId?: string | null };

type CaseDetail = {
  case: {
    id: string;
    caseKey: string;
    jurisdiction: string;
    adminStatus: string;
    currentRevisionId: string;
    regulatoryValidated: boolean;
  };
  revisions: Array<{
    id: string;
    isCurrent: boolean;
    changes: Array<{ field: string; justification: string }> | null;
    fields: RevisionFields | null;
  }>;
};

type PublishedGroup = {
  id: string;
  name: string;
  sortOrder: number;
  isDefault: boolean;
};

type Published = {
  id: string;
  sourceType: string;
  group: PublishedGroup;
  publishedRevisionId: string;
};

type Group = {
  groupId: string;
  jurisdiction: string;
  name: string;
  sortOrder: number;
  retiredAt: string | null;
};

/** The two member cases, resolved once the announcements have projected. */
const caseIds: string[] = [];
/** The admin group the members end up in, and one that stays empty. */
let groupId = "";
let emptyGroupId = "";
let foreignGroupId = "";

async function adminFetch(path: string, init: RequestInit = {}) {
  return await app.fetch(path, {
    ...init,
    headers: { "x-auth-token": ADMIN_TOKEN, ...init.headers },
  });
}

/** Deliver one announcement the way the collectors do — a real envelope
 * through the app's transformer, so the real case projector runs. */
async function seedAnnouncement(seed: { jmNumber: string; title: string }) {
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
        signature: `groups-${seed.jmNumber}-v1`,
        title: seed.title,
        url: `http://127.0.0.1:${WEBHOOK_PORT}/regs/${seed.jmNumber}`,
        status: "current",
        jmNumber: seed.jmNumber,
        region: HOME,
        bodyMarkdown: BODY,
        contentHash: `hash-${seed.jmNumber}`,
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

async function currentFields(caseId: string): Promise<RevisionFields> {
  const detail = await caseDetail(caseId);
  const current = detail.revisions.find((revision) => revision.isCurrent);
  if (!current?.fields) throw new Error("the current revision has no fields");
  return current.fields;
}

/** The non-admin read a skipper's map and the 1st mate go through. */
async function publishedRead(caseId: string): Promise<Published | null> {
  const response = await app.fetch(`/api/regulations/published/${caseId}`, {
    headers: { "x-auth-token": DECKHAND_TOKEN },
  });
  if (response.status === 404) return null;
  expect(response.status).toBe(200);
  return (await response.json()) as Published;
}

/** The whole published set, the way a map load reads it. */
async function publishedList(): Promise<Published[]> {
  const response = await app.fetch(
    "/api/regulations/published?status=all&limit=200",
    { headers: { "x-auth-token": DECKHAND_TOKEN } },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { regulations: Published[] }).regulations;
}

async function listGroups(jurisdiction = HOME): Promise<Group[]> {
  const response = await adminFetch(
    `/api/regulations/groups?jurisdiction=${jurisdiction}`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { groups: Group[] }).groups;
}

async function createGroup(
  name: string,
  jurisdiction = HOME,
): Promise<Response> {
  return await adminFetch("/api/regulations/groups", {
    method: "POST",
    body: JSON.stringify({ jurisdiction, name }),
  });
}

async function createdGroupId(name: string, jurisdiction = HOME) {
  const response = await createGroup(name, jurisdiction);
  expect(response.status).toBe(201);
  return ((await response.json()) as { group: Group }).group.groupId;
}

async function proposeGroup(
  caseId: string,
  nextGroupId: string | null,
  justification: string,
): Promise<Response> {
  const detail = await caseDetail(caseId);
  const fields = await currentFields(caseId);
  return await adminFetch(`/api/regulations/cases/${caseId}/revisions`, {
    method: "POST",
    body: JSON.stringify({
      baseRevisionId: detail.case.currentRevisionId,
      fields: { ...fields, groupId: nextGroupId },
      justifications: { groupId: justification },
    }),
  });
}

/** Validate legally and approve metadata-only — the whole ceremony for a
 * case with no drawn areas, and what moves the published pin. */
async function validateAndApprove(
  caseId: string,
  revisionId: string,
): Promise<void> {
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
    const detail = await caseDetail(caseId);
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
    const published = await publishedRead(caseId);
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
async function waitForCurrentRevision(
  caseId: string,
  revisionId: string,
): Promise<CaseDetail> {
  return await waitFor(async () => {
    const detail = await caseDetail(caseId);
    return detail.case.currentRevisionId === revisionId ? detail : null;
  }, `the revision ${revisionId} never landed`);
}

describe("regulation groups black-box", () => {
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
    // The app starts FIRST: `regulation_groups` only exists once the boot
    // migrator has run, and the cleanup below has to be able to name it.
    await app.start();

    // Only this suite's own rows are cleared — other regulation suites seed
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
    await db`delete from regulation_groups where name like ${`${GROUP_PREFIX}%`}`;

    for (const member of MEMBERS) {
      await seedAnnouncement(member);
      const caseId = await caseIdOf(member.jmNumber);
      caseIds.push(caseId);
      const detail = await caseDetail(caseId);
      await validateAndApprove(caseId, detail.case.currentRevisionId);
    }
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await fishfacts.stop();
    await usable.stop();
    await db.end();
  });

  test("day one: every published regulation sits in its country's default group", async () => {
    for (const caseId of caseIds) {
      const published = await publishedRead(caseId);
      expect(published?.group).toEqual({
        id: DEFAULT_GROUP_ID,
        name: DEFAULT_GROUP_NAME,
        sortOrder: 1000,
        isDefault: true,
      });
    }

    // And the invariant holds across the whole published set, not only the
    // two cases this suite seeded: a default group is always named for its
    // source type, with the raw source type for an unmapped source.
    const labels: Record<string, string> = {
      "fiskeridir-jmelding": "J-melding closures",
      "fiskistofa-wfs": "Closures",
      logasavn: "Statutory closures",
      "vorn-veidibann": "Veiðibann",
    };
    for (const entry of await publishedList()) {
      expect(entry.group).toBeDefined();
      if (!entry.group.isDefault) continue;
      expect(entry.group.name).toBe(
        labels[entry.sourceType] ?? entry.sourceType,
      );
      expect(entry.group.sortOrder).toBeGreaterThanOrEqual(
        DEFAULT_GROUP_SORT_FLOOR,
      );
    }
  });

  test("creating a group offers it to admins and changes nothing for skippers", async () => {
    const before = JSON.stringify(
      await Promise.all(caseIds.map(publishedRead)),
    );

    groupId = await createdGroupId(GROUP_NAME);
    emptyGroupId = await createdGroupId(EMPTY_GROUP_NAME);
    foreignGroupId = await createdGroupId(FOREIGN_GROUP_NAME, ABROAD);

    const groups = await listGroups();
    expect(groups.map((group) => group.name)).toEqual([
      GROUP_NAME,
      EMPTY_GROUP_NAME,
    ]);
    expect(groups.every((group) => group.retiredAt === null)).toBe(true);
    // Appended last, and in the order they were created.
    expect(groups[0]?.sortOrder).toBeLessThan(groups[1]?.sortOrder as number);
    // A group of another country is not offered here.
    expect(groups.some((group) => group.groupId === foreignGroupId)).toBe(
      false,
    );

    // Nothing a skipper reads has moved: a group with no member is not a
    // group anybody can see.
    expect(JSON.stringify(await Promise.all(caseIds.map(publishedRead)))).toBe(
      before,
    );
  });

  test("placing a regulation in a group changes only its group, and reaches users on approval", async () => {
    for (const caseId of caseIds) {
      const before = await currentFields(caseId);
      const proposed = await proposeGroup(
        caseId,
        groupId,
        "Skippers navigate these four by flag, not by statute number.",
      );
      expect(proposed.status).toBe(202);
      const { revisionId } = (await proposed.json()) as { revisionId: string };
      const detail = await waitForCurrentRevision(caseId, revisionId);

      const revision = detail.revisions.find(
        (entry) => entry.id === revisionId,
      );
      expect(revision?.changes).toHaveLength(1);
      expect(revision?.changes?.[0]?.field).toBe("groupId");
      expect(revision?.fields?.groupId).toBe(groupId);
      const withoutGroup = (fields: RevisionFields | null | undefined) => {
        const { groupId: _ignored, ...rest } = fields ?? {};
        return rest;
      };
      expect(withoutGroup(revision?.fields)).toEqual(withoutGroup(before));
      // Placing a regulation in a group is a change to what users see, so
      // the case goes back under review like any other edit.
      expect(detail.case.adminStatus).toBe("under_review");

      // And until it is approved, skippers read the previous grouping.
      expect((await publishedRead(caseId))?.group.isDefault).toBe(true);

      await validateAndApprove(caseId, revisionId);
      const published = await publishedRead(caseId);
      expect(published?.group.id).toBe(groupId);
      expect(published?.group.name).toBe(GROUP_NAME);
      expect(published?.group.isDefault).toBe(false);
    }
  });

  test("renaming and reordering reach users at once and leave every member approved", async () => {
    const before = await Promise.all(
      caseIds.map(async (caseId) => {
        const detail = await caseDetail(caseId);
        const published = await publishedRead(caseId);
        return {
          adminStatus: detail.case.adminStatus,
          publishedRevisionId: published?.publishedRevisionId,
        };
      }),
    );

    const renamed = await adminFetch(
      `/api/regulations/groups/${groupId}/rename`,
      { method: "POST", body: JSON.stringify({ name: GROUP_RENAMED }) },
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { group: Group }).group.name).toBe(
      GROUP_RENAMED,
    );

    // Move it above the group created after it. The request names the
    // country's active groups in full, which is what the event carries.
    const reordered = await adminFetch("/api/regulations/groups/reorder", {
      method: "POST",
      body: JSON.stringify({
        jurisdiction: HOME,
        groupIds: [emptyGroupId, groupId],
      }),
    });
    expect(reordered.status).toBe(200);
    expect(
      ((await reordered.json()) as { groups: Group[] }).groups.map(
        (group) => group.groupId,
      ),
    ).toEqual([emptyGroupId, groupId]);

    for (const [index, caseId] of caseIds.entries()) {
      const published = await publishedRead(caseId);
      // The new name is what users read, immediately.
      expect(published?.group.name).toBe(GROUP_RENAMED);
      expect(published?.group.sortOrder).toBe(1);
      // An admin group always sorts above every default one.
      expect(published?.group.sortOrder).toBeLessThan(DEFAULT_GROUP_SORT_FLOOR);
      // No case left the state it was approved into, and the pin did not
      // move: a navigation label is not a change to the regulation.
      const detail = await caseDetail(caseId);
      expect(detail.case.adminStatus).toBe(before[index]?.adminStatus);
      expect(published?.publishedRevisionId).toBe(
        before[index]?.publishedRevisionId as string,
      );
    }
  });

  test("an empty group and a retired group never reach users", async () => {
    // A group with no approved member is unreachable: groups are only ever
    // read through a member.
    const idsBefore = new Set(
      (await publishedList()).map((entry) => entry.group.id),
    );
    expect(idsBefore.has(emptyGroupId)).toBe(false);
    expect(idsBefore.has(groupId)).toBe(true);

    const pinsBefore = await Promise.all(
      caseIds.map(
        async (caseId) => (await publishedRead(caseId))?.publishedRevisionId,
      ),
    );

    const retired = await adminFetch(
      `/api/regulations/groups/${groupId}/retire`,
      { method: "POST" },
    );
    expect(retired.status).toBe(200);
    expect(
      ((await retired.json()) as { group: Group }).group.retiredAt,
    ).not.toBeNull();

    // Members fall back to their country's default group — nothing is
    // un-published and no pin moves.
    for (const [index, caseId] of caseIds.entries()) {
      const published = await publishedRead(caseId);
      expect(published?.group).toEqual({
        id: DEFAULT_GROUP_ID,
        name: DEFAULT_GROUP_NAME,
        sortOrder: 1000,
        isDefault: true,
      });
      expect(published?.publishedRevisionId).toBe(pinsBefore[index] as string);
    }
    expect(
      (await publishedList()).some((entry) => entry.group.id === groupId),
    ).toBe(false);

    // Admins still see both, so a name they remember is explainable.
    const groups = await listGroups();
    expect(
      groups.find((group) => group.groupId === groupId)?.retiredAt,
    ).not.toBeNull();
    expect(
      groups.find((group) => group.groupId === emptyGroupId)?.retiredAt,
    ).toBeNull();

    // Retiring it again is a no-op rather than a second retirement.
    const again = await adminFetch(
      `/api/regulations/groups/${groupId}/retire`,
      { method: "POST" },
    );
    expect(again.status).toBe(200);
  });

  test("blank, duplicate, unknown, mis-ordered and non-admin group writes are all refused", async () => {
    const blank = await createGroup("   ");
    expect(blank.status).toBe(400);

    const overLong = await createGroup(`${GROUP_PREFIX}${"x".repeat(80)}`);
    expect(overLong.status).toBe(400);

    // Case-insensitive within the country, against ACTIVE groups only.
    const duplicate = await createGroup(EMPTY_GROUP_NAME.toUpperCase());
    expect(duplicate.status).toBe(409);
    expect(
      (await duplicate.json()) as { error: string; groupId: string },
    ).toMatchObject({ error: "group_name_taken", groupId: emptyGroupId });

    // The retired group's name is free again.
    const reused = await createGroup(GROUP_RENAMED);
    expect(reused.status).toBe(201);
    const reusedId = ((await reused.json()) as { group: Group }).group.groupId;

    const renameUnknown = await adminFetch(
      `/api/regulations/groups/${UNKNOWN_GROUP_ID}/rename`,
      {
        method: "POST",
        body: JSON.stringify({ name: `${GROUP_PREFIX}Ghost` }),
      },
    );
    expect(renameUnknown.status).toBe(404);

    const retireUnknown = await adminFetch(
      `/api/regulations/groups/${UNKNOWN_GROUP_ID}/retire`,
      { method: "POST" },
    );
    expect(retireUnknown.status).toBe(404);

    const renameToTaken = await adminFetch(
      `/api/regulations/groups/${reusedId}/rename`,
      { method: "POST", body: JSON.stringify({ name: EMPTY_GROUP_NAME }) },
    );
    expect(renameToTaken.status).toBe(409);

    // A partial order would leave the unnamed groups at positions no replay
    // would reproduce.
    const partial = await adminFetch("/api/regulations/groups/reorder", {
      method: "POST",
      body: JSON.stringify({ jurisdiction: HOME, groupIds: [emptyGroupId] }),
    });
    expect(partial.status).toBe(400);
    expect((await partial.json()) as { reason: string }).toMatchObject({
      reason: "group_order_mismatch",
    });

    // A retired group is not part of the active order either.
    const withRetired = await adminFetch("/api/regulations/groups/reorder", {
      method: "POST",
      body: JSON.stringify({
        jurisdiction: HOME,
        groupIds: [emptyGroupId, reusedId, groupId],
      }),
    });
    expect(withRetired.status).toBe(400);

    const missingJurisdiction = await adminFetch("/api/regulations/groups");
    expect(missingJurisdiction.status).toBe(400);

    for (const [path, init] of [
      ["/api/regulations/groups?jurisdiction=NO", { method: "GET" }],
      [
        "/api/regulations/groups",
        {
          method: "POST",
          body: JSON.stringify({ jurisdiction: HOME, name: "Not an admin" }),
        },
      ],
      [
        `/api/regulations/groups/${emptyGroupId}/rename`,
        { method: "POST", body: JSON.stringify({ name: "Not an admin" }) },
      ],
      [
        "/api/regulations/groups/reorder",
        {
          method: "POST",
          body: JSON.stringify({
            jurisdiction: HOME,
            groupIds: [emptyGroupId],
          }),
        },
      ],
      [`/api/regulations/groups/${emptyGroupId}/retire`, { method: "POST" }],
    ] as Array<[string, RequestInit]>) {
      const response = await app.fetch(path, {
        ...init,
        headers: { "x-auth-token": DECKHAND_TOKEN },
      });
      expect(response.status).toBe(403);
    }
  });

  test("a proposal may not name a foreign, retired or unknown group", async () => {
    const caseId = caseIds[1] as string;
    // Clear the group first: the refusals below have to be refusals of the
    // group, not of a proposal that changes nothing.
    const cleared = await proposeGroup(
      caseId,
      null,
      "Ungrouped until the replacement group is named.",
    );
    expect(cleared.status).toBe(202);
    await waitForCurrentRevision(
      caseId,
      ((await cleared.json()) as { revisionId: string }).revisionId,
    );
    const detail = await caseDetail(caseId);

    const foreign = await proposeGroup(
      caseId,
      foreignGroupId,
      "Wrong country.",
    );
    expect(foreign.status).toBe(400);
    expect((await foreign.json()) as { reason: string }).toMatchObject({
      reason: "group_not_of_jurisdiction",
    });

    const retired = await proposeGroup(caseId, groupId, "Retired group.");
    expect(retired.status).toBe(400);
    expect((await retired.json()) as { reason: string }).toMatchObject({
      reason: "group_retired",
    });

    const unknown = await proposeGroup(
      caseId,
      UNKNOWN_GROUP_ID,
      "No such group.",
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as { reason: string }).toMatchObject({
      reason: "group_not_found",
    });

    // Nothing above landed: the case is exactly where it was.
    const after = await caseDetail(caseId);
    expect(after.case.currentRevisionId).toBe(detail.case.currentRevisionId);
    expect(after.revisions).toHaveLength(detail.revisions.length);
  });

  test("an upper-case group id is stored and resolved as the one group it names", async () => {
    // The group ids in `regulation_groups` are lower-case uuids, so a
    // mixed-case one that validated but was stored raw would silently
    // resolve to the default group at publish time.
    const caseId = caseIds[1] as string;
    const proposed = await proposeGroup(
      caseId,
      emptyGroupId.toUpperCase(),
      "Pasted the id from a log line.",
    );
    expect(proposed.status).toBe(202);
    const { revisionId } = (await proposed.json()) as { revisionId: string };
    const detail = await waitForCurrentRevision(caseId, revisionId);
    expect(
      detail.revisions.find((entry) => entry.id === revisionId)?.fields
        ?.groupId,
    ).toBe(emptyGroupId);

    await validateAndApprove(caseId, revisionId);
    const published = await publishedRead(caseId);
    expect(published?.group.id).toBe(emptyGroupId);
    expect(published?.group.name).toBe(EMPTY_GROUP_NAME);
    expect(published?.group.isDefault).toBe(false);
  });

  test("a collector amendment keeps the group an admin chose", async () => {
    const caseId = caseIds[0] as string;
    const member = MEMBERS[0] as (typeof MEMBERS)[number];
    const active = await createdGroupId(`${GROUP_PREFIX}Still here`);
    const proposed = await proposeGroup(
      caseId,
      active,
      "Re-homed after the old group was retired.",
    );
    expect(proposed.status).toBe(202);
    const { revisionId } = (await proposed.json()) as { revisionId: string };
    await waitForCurrentRevision(caseId, revisionId);

    const amendedTitle = `${member.title} (broytt 1. mars 2026)`;
    await app.fetch("/api/transformer", {
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
          signature: `groups-${member.jmNumber}-v2`,
          title: amendedTitle,
          url: `http://127.0.0.1:${WEBHOOK_PORT}/regs/${member.jmNumber}`,
          status: "current",
          jmNumber: member.jmNumber,
          region: HOME,
          bodyMarkdown: BODY,
          contentHash: `hash-${member.jmNumber}-v2`,
          checkedAt: new Date().toISOString(),
        },
      }),
    });

    const detail = await waitFor(async () => {
      const current = await caseDetail(caseId);
      const revision = current.revisions.find((entry) => entry.isCurrent);
      return revision?.fields?.title === amendedTitle ? current : null;
    }, "the amendment never landed");
    const revision = detail.revisions.find((entry) => entry.isCurrent);
    // The group has no case column, so only the carry-forward keeps it.
    expect(revision?.fields?.groupId).toBe(active);
  });
});
