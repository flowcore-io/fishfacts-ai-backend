import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer, frontmatterOf } from "../fixtures/fake-usable";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

const APP_PORT = 4510;
const USABLE_PORT = 4511;
const FISHFACTS_PORT = 4512;
const WEBHOOK_PORT = 4513;
const DB_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";
const TRANSFORMER_SECRET = "test-transformer-secret";
const ADMIN_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const DECKHAND_TOKEN = "2c2f0b4e-98b2-4a3f-9c6f-2e2f8a55aa01";
const ANNOUNCEMENT_FLOW = "fishfacts-announcement.0";
const ANNOUNCEMENT_EVENT = "jmelding.announcement.discovered.0";
const REGULATION_FLOW = "fishfacts-regulation-queue.0";
const SYNC_JOB_ID = "regulation-published-sync";

/**
 * Keyed `pa-` so this suite clears its OWN rows: other regulation suites seed
 * into the same database and truncating would pull the rug from under them.
 */
const CASE_KEY_PREFIX = "pa-";

/**
 * Four approved regulations, one per state the corpus has to tell apart. The
 * applicability each carries is what an admin confirms on the admin surface —
 * proposed as a revision and approved, the same path the extraction job's
 * proposal and the admin chat's correction take. Every quote is copied out of
 * the case's own text, as the extraction demands.
 */
const CASES = {
  /** A closure keyed on gear and a bound printed in gross tonnage. */
  stated: {
    jmNumber: "pa-01-2026",
    title: "J-201-2026 Forbud mot torsketrål for små fartøy",
    body: "Det er forbudt å fiske med torsketrål for fartøy under 120 BT.",
    applicability: {
      gear: ["torsketrål"],
      vesselLength: { max: "120 BT" },
      activity: "prohibited",
      evidence: {
        gear: "forbudt å fiske med torsketrål",
        vesselLength: "fartøy under 120 BT",
        activity: "Det er forbudt å fiske",
      },
      notes: "ADMIN-ONLY: sjekk forskriften om tonnasje.",
    },
  },
  /** A seasonal permission — K 27/2024's flatfish areas, in miniature. */
  permission: {
    jmNumber: "pa-02-2026",
    title: "J-202-2026 Adgang til å fiske flatfisk",
    body: "Det er tillatt å fiske flatfisk i området fra 1. mai.",
    applicability: {
      species: ["flatfisk"],
      activity: "allowed",
      evidence: {
        species: "fiske flatfisk",
        activity: "Det er tillatt å fiske flatfisk",
      },
    },
  },
  /** Nobody has extracted it — approved on its legal text alone. */
  unextracted: {
    jmNumber: "pa-03-2026",
    title: "J-203-2026 Stenging uten avgrensning lest",
    body: "Området er stengt for alt fiske.",
    applicability: null,
  },
  /** Extracted, and the source restricts nobody: a note and nothing else. */
  unrestricted: {
    jmNumber: "pa-04-2026",
    title: "J-204-2026 Melding uten avgrensning",
    body: "Meldingen sier ingenting om hvem den gjelder.",
    applicability: { notes: "ADMIN-ONLY: kilden nevner ingen avgrensning." },
  },
  /** Empty lists as production holds them: they narrow nothing, so only the
   * gear is a stated restriction. */
  emptyLists: {
    jmNumber: "pa-05-2026",
    title: "J-205-2026 Forbud mot trål i området",
    body: "Det er forbudt å fiske med trol i området.",
    applicability: {
      gear: ["trol"],
      species: [],
      fishery: [],
      evidence: { gear: "fiske med trol" },
    },
  },
} as const;

type CaseSeed = (typeof CASES)[keyof typeof CASES];

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

type CaseDetail = {
  case: {
    id: string;
    currentRevisionId: string;
    regulatoryValidated: boolean;
  };
  revisions: Array<{
    id: string;
    isCurrent: boolean;
    fields: Record<string, unknown> | null;
  }>;
};

type CorpusFragment = {
  id: string;
  key?: string;
  content: string;
};

async function adminFetch(path: string, init: RequestInit = {}) {
  return await app.fetch(path, {
    ...init,
    headers: { "x-auth-token": ADMIN_TOKEN, ...init.headers },
  });
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

/** Deliver one announcement the way the collectors do — a real envelope
 * through the app's transformer, so the real case projector runs. */
async function seedAnnouncement(seed: CaseSeed) {
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
        signature: `published-applicability-${seed.jmNumber}-v1`,
        title: seed.title,
        url: `http://127.0.0.1:${WEBHOOK_PORT}/regs/${seed.jmNumber}`,
        status: "current",
        jmNumber: seed.jmNumber,
        region: "NO",
        bodyMarkdown: seed.body,
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
  return await waitFor(async () => {
    const response = await adminFetch("/api/regulations/queue?limit=200");
    const body = (await response.json()) as {
      cases: Array<{ id: string; caseKey: string }>;
    };
    return body.cases.find((entry) => entry.caseKey.endsWith(`:${jmNumber}`))
      ?.id;
  }, `case ${jmNumber} was not projected`);
}

async function caseDetail(caseId: string): Promise<CaseDetail> {
  const response = await adminFetch(`/api/regulations/cases/${caseId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as CaseDetail;
}

/** Propose a revision that sets the applicability and nothing else, and
 * wait for it to become the current revision. */
async function proposeApplicability(
  caseId: string,
  applicability: unknown,
): Promise<string> {
  const detail = await caseDetail(caseId);
  const current = detail.revisions.find((revision) => revision.isCurrent);
  if (!current?.fields) throw new Error("the current revision has no fields");
  const proposed = await adminFetch(
    `/api/regulations/cases/${caseId}/revisions`,
    {
      method: "POST",
      body: JSON.stringify({
        baseRevisionId: detail.case.currentRevisionId,
        fields: { ...current.fields, applicability },
        justifications: { applicability: "Confirmed against the source." },
      }),
    },
  );
  expect(proposed.status).toBe(202);
  const { revisionId } = (await proposed.json()) as { revisionId: string };
  await waitFor(async () => {
    const after = await caseDetail(caseId);
    return after.case.currentRevisionId === revisionId;
  }, `the applicability revision for ${caseId} never landed`);
  return revisionId;
}

/** Validate legally and approve metadata-only — what pins the revision and
 * schedules the published sync. */
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
  await waitFor(
    async () => (await caseDetail(caseId)).case.regulatoryValidated,
    "the validation never landed",
  );

  const approved = await adminFetch(
    `/api/regulations/cases/${caseId}/approval`,
    {
      method: "POST",
      body: JSON.stringify({ revisionId, metadataOnly: true, note: "ok" }),
    },
  );
  expect(approved.status).toBe(202);
  await waitFor(async () => {
    const response = await app.fetch(`/api/regulations/published/${caseId}`, {
      headers: { "x-auth-token": DECKHAND_TOKEN },
    });
    if (response.status !== 200) return false;
    const published = (await response.json()) as {
      publishedRevisionId: string;
    };
    return published.publishedRevisionId === revisionId;
  }, "the approval never pinned the revision");
}

/** The case's published-corpus fragment as the fake Usable holds it. */
function corpusFragment(seed: CaseSeed): CorpusFragment | undefined {
  return Array.from(usable.fragments.values()).find(
    (fragment) =>
      fragment.key?.startsWith("regulation-published-") &&
      fragment.key.endsWith(seed.jmNumber),
  );
}

/** The case's fragment, which the setup test proved was written. */
function writtenFragment(seed: CaseSeed): CorpusFragment {
  const fragment = corpusFragment(seed);
  if (!fragment) {
    throw new Error(
      `${seed.jmNumber} is not in the corpus — see the setup test`,
    );
  }
  return fragment;
}

/** The fragment's `## Applicability` section, up to the next heading. */
function applicabilitySection(fragment: CorpusFragment): string {
  const match = fragment.content.match(
    /\n## Applicability\n\n([\s\S]*?)\n\n## Areas\n/,
  );
  if (!match) {
    throw new Error(`no Applicability section in:\n${fragment.content}`);
  }
  return match[1] ?? "";
}

function patchesTo(fragment: CorpusFragment): number {
  const path = `/api/memory-fragments/${fragment.id}`;
  return usable.calls.filter(
    (call) => call.method === "PATCH" && call.path === path,
  ).length;
}

/**
 * Wait until the published sync has gone quiet: no Usable traffic for longer
 * than the trigger's debounce (3 s), so nothing an approval scheduled is
 * still pending when the test starts counting writes.
 */
async function waitForQuietSync(): Promise<void> {
  const quietMs = 4000;
  const deadline = Date.now() + 30000;
  let seen = usable.calls.length;
  let since = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    if (usable.calls.length !== seen) {
      seen = usable.calls.length;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
  throw new Error("the published sync never went quiet");
}

type SyncJobState = {
  runningJobIds: string[];
  state: {
    jobs: Record<
      string,
      { lastRunStatus?: string; lastError?: string; lastRunAt?: string }
    >;
  };
};

async function jobState(): Promise<SyncJobState> {
  const response = await adminFetch("/api/jobs/state");
  expect(response.status).toBe(200);
  return (await response.json()) as SyncJobState;
}

/**
 * One manual published sync, the admin's `POST /api/jobs/run`, to the end —
 * and it has to have SUCCEEDED, or the failure is reported by its own error
 * instead of as a missing fragment later.
 *
 * The approvals' event-triggered sync may still be running (or retrying on
 * its backoff) when this is called, and the runner refuses a second start of
 * the same job. So: wait until no sync runs, start ours, and start again if
 * an event-triggered run won the race in between.
 */
async function runPublishedSync(): Promise<void> {
  const deadline = Date.now() + 60000;
  let runId: string | null = null;
  while (runId === null) {
    if (Date.now() > deadline) {
      throw new Error("the manual published sync never got to start");
    }
    await waitFor(
      async () => !(await jobState()).runningJobIds.includes(SYNC_JOB_ID),
      "a running published sync never finished",
    );
    const run = await adminFetch("/api/jobs/run", {
      method: "POST",
      body: JSON.stringify({ jobId: SYNC_JOB_ID }),
    });
    if (run.status === 202) {
      runId = ((await run.json()) as { runId: string }).runId;
    } else {
      await Bun.sleep(200);
    }
  }
  const finished = await waitFor(async () => {
    const state = await jobState();
    return state.runningJobIds.includes(SYNC_JOB_ID) ? null : state;
  }, "the manual published sync never finished");
  const job = finished.state.jobs[SYNC_JOB_ID];
  if (job?.lastRunStatus !== "success") {
    throw new Error(
      `the manual published sync ${runId} ended ${job?.lastRunStatus}: ${job?.lastError}`,
    );
  }
}

describe("published corpus applicability black-box", () => {
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
    await app.start();

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
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await fishfacts.stop();
    await usable.stop();
    await db.end();
  });

  // Seeding lives in a test, not in beforeAll: five approvals take longer
  // than the 5 s a hook gets, and a hook cannot be given more on the Bun CI
  // pins. Every test below reads what this one proved was written.
  test("five approved regulations reach the published corpus", async () => {
    for (const seed of Object.values(CASES)) {
      await seedAnnouncement(seed);
      const caseId = await caseIdOf(seed.jmNumber);
      const revisionId =
        seed.applicability === null
          ? (await caseDetail(caseId)).case.currentRevisionId
          : await proposeApplicability(caseId, seed.applicability);
      await validateAndApprove(caseId, revisionId);
    }
    // Let the approvals' own syncs settle, then run one to the end: from
    // here on the corpus holds exactly what the published set says, without
    // depending on how long the debounce and the sync took on this machine.
    await waitForQuietSync();
    await runPublishedSync();
    for (const seed of Object.values(CASES)) {
      expect(corpusFragment(seed)?.content).toContain("\n## Applicability\n");
    }
  }, 120000);

  test("a stated dimension is written with its values and the source quote behind it", async () => {
    const section = applicabilitySection(writtenFragment(CASES.stated));
    expect(section).toContain(
      "- Gear: torsketrål — source: “forbudt å fiske med torsketrål”",
    );
    expect(section).toContain(
      "- Activity: prohibited — the listed activity is prohibited inside its areas — source: “Det er forbudt å fiske”",
    );
    // The corpus names the conditions and never claims a vessel verdict.
    expect(section).toContain(
      "Whether it applies to a specific vessel depends on that vessel's own facts",
    );
  }, 30000);

  test("a bound printed as 120 BT is printed as written, never converted", async () => {
    const section = applicabilitySection(writtenFragment(CASES.stated));
    expect(section).toContain(
      "- Vessel length: up to 120 BT — source: “fartøy under 120 BT”",
    );
    expect(section).not.toMatch(/\d\s*m\b|metre|meter/i);
  }, 30000);

  test("an allowed activity reads as a permission, not a closure", async () => {
    const section = applicabilitySection(writtenFragment(CASES.permission));
    expect(section).toContain(
      "- Activity: allowed — this regulation is a permission, not a closure: the listed activity is allowed inside its areas under the conditions stated here — source: “Det er tillatt å fiske flatfisk”",
    );
    expect(section).toContain("- Species: flatfisk — source: “fiske flatfisk”");
    expect(section).not.toContain("prohibited");
  }, 30000);

  test("an applicability nobody extracted says it cannot be confirmed for any vessel", async () => {
    const section = applicabilitySection(writtenFragment(CASES.unextracted));
    expect(section).toBe(
      "Applicability has not been extracted for this regulation, so it cannot be confirmed that it applies to any particular vessel.",
    );
  }, 30000);

  test("an applicability with no dimension says the source states no restriction", async () => {
    const section = applicabilitySection(writtenFragment(CASES.unrestricted));
    expect(section).toBe(
      "The source states no restriction on who or what this regulation applies to.",
    );
  }, 30000);

  test("empty lists narrow nothing: the gear gets a line, the empty species and fishery do not", async () => {
    const section = applicabilitySection(writtenFragment(CASES.emptyLists));
    expect(section).toContain("- Gear: trol — source: “fiske med trol”");
    expect(section).not.toContain("- Species:");
    expect(section).not.toContain("- Fishery:");
    expect(section).not.toContain("none listed");
  }, 30000);

  test("the admin's notes never reach the corpus", async () => {
    for (const seed of [CASES.stated, CASES.unrestricted]) {
      const fragment = writtenFragment(seed);
      expect(fragment.content).not.toContain("ADMIN-ONLY");
    }
  }, 30000);

  test("a fragment the previous renderer wrote is rewritten once by the next sync, then left alone", async () => {
    const written = writtenFragment(CASES.stated);
    // Let the approvals' syncs finish, so only the runs below write.
    await waitForQuietSync();

    // What the previous release wrote for the same pinned revision: the same
    // frontmatter without the render version, and no Applicability section.
    const legacyContent = written.content
      .replace(/^renderVersion: .*\n/m, "")
      .replace(/\n## Applicability\n\n[\s\S]*?(?=\n## Areas\n)/, "");
    expect(legacyContent).not.toContain("## Applicability");
    expect(frontmatterOf(legacyContent)?.renderVersion).toBeUndefined();
    usable.fragments.set(written.id, {
      ...(usable.fragments.get(written.id) as NonNullable<
        ReturnType<typeof usable.fragments.get>
      >),
      content: legacyContent,
    });

    const before = patchesTo(written);
    await runPublishedSync();
    expect(patchesTo(written)).toBe(before + 1);
    const rewritten = corpusFragment(CASES.stated) as CorpusFragment;
    expect(rewritten.id).toBe(written.id);
    expect(applicabilitySection(rewritten)).toContain(
      "- Gear: torsketrål — source: “forbudt å fiske med torsketrål”",
    );
    const renderVersion = frontmatterOf(rewritten.content)?.renderVersion;
    expect(renderVersion).toBeNumber();

    // And the sync after that finds it current: no write at all.
    await runPublishedSync();
    expect(patchesTo(written)).toBe(before + 1);
    expect(corpusFragment(CASES.stated)?.content).toBe(rewritten.content);
  }, 60000);
});
