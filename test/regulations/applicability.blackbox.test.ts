import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AppProcess } from "../fixtures/app-process";
import { FakeFishfactsServer } from "../fixtures/fake-fishfacts";
import { FakeUsableServer } from "../fixtures/fake-usable";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

const APP_PORT = 4470;
const USABLE_PORT = 4471;
const FISHFACTS_PORT = 4472;
const WEBHOOK_PORT = 4473;
const DB_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";
const TRANSFORMER_SECRET = "test-transformer-secret";
const ADMIN_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";
const DECKHAND_TOKEN = "2c2f0b4e-98b2-4a3f-9c6f-2e2f8a55aa01";
const ANNOUNCEMENT_FLOW = "fishfacts-announcement.0";
const ANNOUNCEMENT_EVENT = "jmelding.announcement.discovered.0";
const REGULATION_FLOW = "fishfacts-regulation-queue.0";
const JOB_ID = "regulation-applicability";
/** A syntactically valid case id that is not in the database. */
const UNKNOWN_CASE_ID = "a1b2c3d4-1111-4111-8111-1111deadbeef";

/**
 * Four cases, seeded through the real announcement → case projection, so the
 * backfill order has something to sort: a PUBLISHED Norwegian one, a FAROESE
 * one, an unpublished Norwegian one, and one with no source text at all.
 */
const CASES = {
  published: {
    jmNumber: "j-90-2026",
    region: "NO",
    title: "J-90-2026 Forbud mot å fiske med torsketrål på Røstbanken",
    body: [
      "Det er forbudt å fiske med torsketrål på Røstbanken.",
      "Forbudet gjelder ikke fartøy under 15 meter som fisker med garn.",
    ].join("\n"),
  },
  faroese: {
    jmNumber: "fo-90-2026",
    region: "FO",
    title: "Veiðibann á Sandoyarbanka",
    body: "Hetta skjalið sigur einki um, hvørjum reglan fevnir um.",
  },
  norwegian: {
    jmNumber: "j-91-2026",
    region: "NO",
    title: "J-91-2026 Stenging av område i Barentshavet",
    body: "Det er forbudt å fiske med snurrevad i det stengte området.",
  },
  textless: {
    jmNumber: "j-92-2026",
    region: "NO",
    title: "J-92-2026 Melding uten tekst",
    body: "",
  },
} as const;

/** The happy answer for the published case: both values, both quoted. */
const PUBLISHED_ANSWER = JSON.stringify({
  gear: ["torsketrål"],
  activity: "prohibited",
  exemptions: ["fartøy under 15 meter som fisker med garn"],
  evidence: {
    gear: "forbudt å fiske med torsketrål",
    activity: "Det er forbudt å fiske",
    exemptions: "Forbudet gjelder ikke fartøy under 15 meter",
  },
  notes: "Ingen artsavgrensing oppgitt.",
});

/** The Faroese case states no rule at all — a note and nothing else. */
const FAROESE_ANSWER = JSON.stringify({
  notes: "Skjalið sigur einki um avmarking; sí høvuðslógina.",
});

/**
 * The Norwegian case gets a BROADENED value behind an honest quote: the
 * source says "snurrevad", the answer says "vad". The quote is real, the
 * value is not what the text says — the Røstbanken failure, in miniature.
 */
const INVENTED_ANSWER = JSON.stringify({
  gear: ["vad"],
  evidence: { gear: "å fiske med snurrevad" },
});

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

type JobResult = {
  summary: string;
  dryRun: boolean;
  proposed: Array<{
    caseKey: string;
    title: string;
    revisionId: string | null;
  }>;
  failed: Array<{
    caseKey: string;
    title: string;
    reason: string;
    detail?: string;
  }>;
};

type Revision = {
  id: string;
  author: string;
  isCurrent: boolean;
  changes: Array<{ field: string; justification: string }> | null;
  fields: Record<string, unknown> | null;
  snapshotText: string | null;
};

async function adminFetch(path: string, init: RequestInit = {}) {
  return await app.fetch(path, {
    ...init,
    headers: { "x-auth-token": ADMIN_TOKEN, ...init.headers },
  });
}

async function seedCase(seed: {
  jmNumber: string;
  region: string;
  title: string;
  body: string;
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
        signature: `applicability-${seed.jmNumber}`,
        title: seed.title,
        url: `http://127.0.0.1:${WEBHOOK_PORT}/regs/${seed.jmNumber}`,
        status: "current",
        jmNumber: seed.jmNumber,
        region: seed.region,
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

async function queueCases(): Promise<
  Array<{ id: string; caseKey: string; title: string }>
> {
  const response = await adminFetch("/api/regulations/queue?limit=200");
  const body = (await response.json()) as {
    cases: Array<{ id: string; caseKey: string; title: string }>;
  };
  return body.cases;
}

async function caseIdOf(jmNumber: string): Promise<string> {
  const match = (await queueCases()).find((entry) =>
    entry.caseKey.endsWith(`:${jmNumber}`),
  );
  if (!match) throw new Error(`case ${jmNumber} was not projected`);
  return match.id;
}

async function caseDetail(caseId: string) {
  const response = await adminFetch(`/api/regulations/cases/${caseId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    case: {
      caseKey: string;
      applicability: unknown;
      currentRevisionId: string;
    };
    revisions: Revision[];
  };
}

async function waitFor<T>(
  read: () => Promise<T | null | undefined | false>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as T;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

/** The run's outcome as the admin sees it: the job state's last message. */
async function lastRunResult(): Promise<JobResult> {
  return await waitFor(async () => {
    const response = await adminFetch("/api/jobs/state");
    const state = (await response.json()) as {
      runningJobIds: string[];
      state: {
        jobs: Record<
          string,
          { lastRunStatus?: string; progress?: { message?: string } }
        >;
      };
    };
    if (state.runningJobIds.includes(JOB_ID)) return null;
    const job = state.state.jobs[JOB_ID];
    if (job?.lastRunStatus !== "success" || !job.progress?.message) return null;
    return JSON.parse(job.progress.message) as JobResult;
  }, "the applicability job did not finish");
}

async function resetJobState() {
  await db`truncate table job_state, job_runs`;
}

describe("regulation applicability black-box", () => {
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
    // The backfill ORDER is the assertion, so this suite owns the case table.
    await db`truncate table regulation_cases, regulation_case_revisions, regulation_case_geometries, regulation_case_sources, regulation_case_links, regulation_case_actions, regulation_case_validations, regulation_case_approvals`;
    await resetJobState();
    await app.start();

    // Order of ingestion is deliberately NOT the expected order.
    await seedCase(CASES.textless);
    await seedCase(CASES.norwegian);
    await seedCase(CASES.faroese);
    await seedCase(CASES.published);

    // Publish one case, so the backfill has a published band to sort first.
    // Legal validation + a metadata-only approval is the whole ceremony for a
    // case with no drawn areas.
    const publishedId = await caseIdOf(CASES.published.jmNumber);
    const detail = await caseDetail(publishedId);
    const baseRevisionId = detail.case.currentRevisionId;
    const validated = await adminFetch(
      `/api/regulations/cases/${publishedId}/validations`,
      {
        method: "POST",
        body: JSON.stringify({
          revisionId: baseRevisionId,
          scope: "legal",
          validated: true,
          note: "seed",
        }),
      },
    );
    expect(validated.status).toBe(202);
    const approved = await adminFetch(
      `/api/regulations/cases/${publishedId}/approval`,
      {
        method: "POST",
        body: JSON.stringify({
          revisionId: baseRevisionId,
          metadataOnly: true,
          note: "seed",
        }),
      },
    );
    expect(approved.status).toBe(202);
    await waitFor(async () => {
      const rows = await db`
        select published_revision_id from regulation_cases where id = ${publishedId}
      `;
      return rows[0]?.published_revision_id !== null;
    }, "the seeded case was never published");
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await fishfacts.stop();
    await usable.stop();
    await db.end();
  });

  test("the backfill reads published, then Faroese, then the rest — and names what it cannot read", async () => {
    usable.queueEmbedChatAnswer(
      PUBLISHED_ANSWER,
      FAROESE_ANSWER,
      INVENTED_ANSWER,
    );
    const started = await adminFetch("/api/jobs/run", {
      method: "POST",
      body: JSON.stringify({ jobId: JOB_ID, args: { limit: 10 } }),
    });
    expect(started.status).toBe(202);

    const result = await lastRunResult();

    // The model saw the three readable cases in the decided order.
    expect(usable.embedChatPrompts).toHaveLength(3);
    expect(usable.embedChatPrompts[0]).toContain(CASES.published.body);
    expect(usable.embedChatPrompts[1]).toContain(CASES.faroese.body);
    expect(usable.embedChatPrompts[2]).toContain(CASES.norwegian.body);

    expect(result.dryRun).toBe(false);
    expect(result.proposed.map((entry) => entry.title)).toEqual([
      CASES.published.title,
      CASES.faroese.title,
    ]);

    // A case that cannot be read is REPORTED, never skipped silently.
    const textless = result.failed.find(
      (entry) => entry.title === CASES.textless.title,
    );
    expect(textless?.reason).toBe("no_source_text");

    // And a value the source never printed is refused by name, with no
    // revision proposed for it.
    const invented = result.failed.find(
      (entry) => entry.title === CASES.norwegian.title,
    );
    expect(invented?.reason).toBe("value_not_in_source");
    expect(invented?.detail).toContain("gear");
    expect(invented?.detail).toContain("vad");

    const norwegian = await caseDetail(
      await caseIdOf(CASES.norwegian.jmNumber),
    );
    expect(norwegian.revisions).toHaveLength(1);
    expect(norwegian.case.applicability).toBeNull();
  });

  test("the proposal changes applicability and nothing else, every value quoted from the source", async () => {
    const detail = await caseDetail(await caseIdOf(CASES.published.jmNumber));
    expect(detail.revisions).toHaveLength(2);
    const [base, proposal] = detail.revisions;
    if (!base || !proposal) return;

    expect(proposal.isCurrent).toBe(true);
    expect(proposal.author).toBe("job:regulation-applicability");
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes?.[0]?.field).toBe("applicability");
    expect(proposal.changes?.[0]?.justification).toContain("gear");

    // Every other field is the base's, untouched.
    const withoutApplicability = (fields: Record<string, unknown> | null) => {
      const { applicability: _ignored, ...rest } = fields ?? {};
      return rest;
    };
    expect(withoutApplicability(proposal.fields)).toEqual(
      withoutApplicability(base.fields),
    );

    const applicability = (
      proposal.fields as {
        applicability: {
          gear: string[];
          activity: string;
          evidence: Record<string, string>;
          notes: string;
        };
      }
    ).applicability;
    expect(applicability.gear).toEqual(["torsketrål"]);
    expect(applicability.activity).toBe("prohibited");
    expect(applicability.notes).toContain("Ingen");
    // The point of the whole feature: the admin can find every quote in the
    // text the case actually carries.
    for (const quote of Object.values(applicability.evidence)) {
      expect(base.snapshotText ?? "").toContain(quote);
    }
    // And the case itself now shows it.
    expect(detail.case.applicability).toMatchObject({ gear: ["torsketrål"] });
  });

  test("a source that states no rule yields a note and no dimension at all", async () => {
    const detail = await caseDetail(await caseIdOf(CASES.faroese.jmNumber));
    expect(detail.case.applicability).toEqual({
      notes: "Skjalið sigur einki um avmarking; sí høvuðslógina.",
    });
    const proposal = detail.revisions.at(-1);
    expect(proposal?.changes?.[0]?.justification).toContain("no applicability");
  });

  test("the per-case trigger re-extracts, 403s a deckhand and 404s an unknown case", async () => {
    const caseId = await caseIdOf(CASES.norwegian.jmNumber);

    const forbidden = await app.fetch(
      `/api/regulations/cases/${caseId}/extract-applicability`,
      { method: "POST", headers: { "x-auth-token": DECKHAND_TOKEN } },
    );
    expect(forbidden.status).toBe(403);

    const missing = await adminFetch(
      `/api/regulations/cases/${UNKNOWN_CASE_ID}/extract-applicability`,
      { method: "POST" },
    );
    expect(missing.status).toBe(404);

    await resetJobState();
    usable.queueEmbedChatAnswer(
      JSON.stringify({
        gear: ["snurrevad"],
        evidence: { gear: "å fiske med snurrevad" },
      }),
    );
    const started = await adminFetch(
      `/api/regulations/cases/${caseId}/extract-applicability`,
      { method: "POST" },
    );
    expect(started.status).toBe(202);
    const accepted = (await started.json()) as {
      jobId: string;
      runId: string;
      caseKey: string;
    };
    expect(accepted.jobId).toBe(JOB_ID);
    expect(accepted.runId).toBeString();

    const result = await lastRunResult();
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0]?.title).toBe(CASES.norwegian.title);

    const detail = await caseDetail(caseId);
    expect(detail.case.applicability).toMatchObject({ gear: ["snurrevad"] });
  });

  test("a dry run extracts and reports but writes nothing", async () => {
    const caseId = await caseIdOf(CASES.faroese.jmNumber);
    const before = await caseDetail(caseId);
    await resetJobState();
    usable.queueEmbedChatAnswer(FAROESE_ANSWER);
    const started = await adminFetch("/api/jobs/run", {
      method: "POST",
      body: JSON.stringify({
        jobId: JOB_ID,
        args: { caseKeys: [before.case.caseKey], limit: 1, dryRun: true },
      }),
    });
    expect(started.status).toBe(202);

    const result = await lastRunResult();
    expect(result.dryRun).toBe(true);
    expect(result.proposed).toEqual([
      {
        caseKey: before.case.caseKey,
        title: CASES.faroese.title,
        revisionId: null,
      },
    ]);
    const after = await caseDetail(caseId);
    expect(after.revisions).toHaveLength(before.revisions.length);
  });

  test("a named list of cases is never truncated by the run's limit", async () => {
    const faroese = await caseDetail(await caseIdOf(CASES.faroese.jmNumber));
    const norwegian = await caseDetail(
      await caseIdOf(CASES.norwegian.jmNumber),
    );
    await resetJobState();
    usable.queueEmbedChatAnswer(FAROESE_ANSWER, FAROESE_ANSWER);
    const started = await adminFetch("/api/jobs/run", {
      method: "POST",
      body: JSON.stringify({
        jobId: JOB_ID,
        args: {
          // Two cases named, a limit of one: naming them IS the decision to
          // spend, so the tail must not be dropped silently.
          caseKeys: [faroese.case.caseKey, norwegian.case.caseKey],
          limit: 1,
        },
      }),
    });
    expect(started.status).toBe(202);

    const result = await lastRunResult();
    expect(
      [...result.proposed, ...result.failed]
        .map((entry) => entry.caseKey)
        .sort(),
    ).toEqual([faroese.case.caseKey, norwegian.case.caseKey].sort());
  });

  test("an admin corrects the proposal, approves it, and the published case carries the correction", async () => {
    const caseId = await caseIdOf(CASES.published.jmNumber);
    const detail = await caseDetail(caseId);
    const proposal = detail.revisions.at(-1);
    if (!proposal?.fields) return;
    const revisionsBefore = detail.revisions.length;

    // The correction the admin chat's propose_case_revision tool makes: the
    // quote stays, the note stays, the value is the admin's.
    const corrected = {
      ...proposal.fields,
      applicability: {
        gear: ["torsketrål"],
        species: ["torsk"],
        activity: "prohibited",
        evidence: {
          gear: "forbudt å fiske med torsketrål",
          species: "torsketrål",
          activity: "Det er forbudt å fiske",
        },
        notes: "Arten står i redskapsnavnet.",
      },
    };
    const proposed = await adminFetch(
      `/api/regulations/cases/${caseId}/revisions`,
      {
        method: "POST",
        body: JSON.stringify({
          baseRevisionId: detail.case.currentRevisionId,
          fields: corrected,
          justifications: {
            applicability: "Torsk følger av redskapet; bekreftet av admin.",
          },
        }),
      },
    );
    expect(proposed.status).toBe(202);
    const { revisionId } = (await proposed.json()) as { revisionId: string };
    await waitFor(async () => {
      const after = await caseDetail(caseId);
      return after.case.currentRevisionId === revisionId;
    }, "the correction never landed");

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
        body: JSON.stringify({
          revisionId,
          metadataOnly: true,
          note: "approved",
        }),
      },
    );
    expect(approved.status).toBe(202);
    await waitFor(async () => {
      const rows =
        await db`select published_revision_id from regulation_cases where id = ${caseId}`;
      return rows[0]?.published_revision_id === revisionId;
    }, "the approval never pinned the correction");

    const published = await adminFetch("/api/regulations/published?limit=50");
    expect(published.status).toBe(200);
    const body = (await published.json()) as {
      regulations: Array<{
        caseKey: string;
        applicability: { species?: string[]; notes?: string } | null;
      }>;
    };
    const entry = body.regulations.find(
      (item) => item.caseKey === detail.case.caseKey,
    );
    expect(entry?.applicability?.species).toEqual(["torsk"]);
    expect(entry?.applicability?.notes).toBe("Arten står i redskapsnavnet.");

    // History keeps both: the machine's reading and the human's correction.
    const after = await caseDetail(caseId);
    expect(after.revisions).toHaveLength(revisionsBefore + 1);
    expect(after.revisions.at(-2)?.author).toBe("job:regulation-applicability");
    expect(after.revisions.at(-1)?.author).toContain("admin:");
  });
});
