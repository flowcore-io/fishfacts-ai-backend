import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { AppProcess } from "./fixtures/app-process";
import { FakeFishfactsServer } from "./fixtures/fake-fishfacts";
import { FakeFiskeridirServer } from "./fixtures/fake-fiskeridir";
import { FakeUsableServer } from "./fixtures/fake-usable";
import { WebhookTestFixture } from "./fixtures/webhook.fixture";

const APP_PORT = 4410;
const WEBHOOK_PORT = 4411;
const USABLE_PORT = 4412;
const FISKERIDIR_PORT = 4413;
const FISHFACTS_PORT = 4414;
const TRANSFORMER_SECRET = "test-transformer-secret";
const FLOW_TYPE = "fishfacts-announcement.0";
const EVENT_TYPE = "jmelding.announcement.discovered.0";
const VALID_AUTH_TOKEN = "433069ad-0dd0-46e5-a832-6960cd6690b5";

function fixtureAnnouncementPayload() {
  return {
    signature: "fixture-replay-signature",
    title: "J-1-2026 Testregulering for fisket etter sild",
    url: `http://127.0.0.1:${FISKERIDIR_PORT}/yrkesfiske/j-meldinger/j-1-2026`,
    status: "current",
    publishedAt: "01.01.2026",
    createdAt: "2026-01-01T00:00:00.000Z",
    jmNumber: "j-1-2026",
    validFrom: "01.01.2026",
    category: "sild",
    bodyMarkdown: "Replay body",
    contentHash: "fixture-content-hash",
    checkedAt: new Date().toISOString(),
  };
}

const usable = new FakeUsableServer(USABLE_PORT);
const fiskeridir = new FakeFiskeridirServer(FISKERIDIR_PORT);
const fishfacts = new FakeFishfactsServer(FISHFACTS_PORT);
const webhook = new WebhookTestFixture({
  port: WEBHOOK_PORT,
  secret: TRANSFORMER_SECRET,
  transformerUrl: `http://127.0.0.1:${APP_PORT}/api/transformer`,
}).addEndpoint(FLOW_TYPE, EVENT_TYPE, true);
const app = new AppProcess(APP_PORT, {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test",
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
  JMELDING_FRAGMENT_TYPE_ID: "68505bca-a549-45eb-bca6-965f87195b89",
  JOB_STATE_FRAGMENT_TYPE_ID: "11da02d0-b033-43a4-acd1-96f9e193cc86",
  JOB_SCHEDULER_ENABLED: "false",
  FISKERIDIR_JMELDINGER_BASE_URL: fiskeridir.baseUrl,
  FISHFACTS_API_BASE_URL: fishfacts.baseUrl,
  FISHFACTS_APPLICATION: "FISHFACTS",
});

async function waitFor<T>(read: () => T | Promise<T>, message: string) {
  const deadline = Date.now() + 5000;
  let last: T;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

describe("J-meldinger jobs black-box", () => {
  beforeAll(async () => {
    await usable.start();
    await fiskeridir.start();
    await fishfacts.start();
    fishfacts.addValidToken(VALID_AUTH_TOKEN, {
      authorities: ["FISHFACTS", "USER", "ADMIN"],
    });
    await webhook.start();
    await app.start();
  });

  beforeEach(() => {
    webhook.clear();
  });

  afterAll(async () => {
    await app.stop();
    await webhook.stop();
    await fishfacts.stop();
    await fiskeridir.stop();
    await usable.stop();
  });

  test("job run emits Flowcore announcement event and reconstructs Usable fragment", async () => {
    const response = await app.fetch("/api/jobs/run", {
      method: "POST",
      headers: { "x-auth-token": VALID_AUTH_TOKEN },
      body: JSON.stringify({
        jobId: "fiskeridir-jmeldinger",
        waitForCompletion: true,
        args: { maxItems: 1, maxPages: 1, includeArchived: true },
      }),
    });

    expect(response.status).toBe(202);
    const started = await response.json();
    expect(started.state).toMatchObject({ lastRunStatus: "running" });

    const event = await waitFor(
      () => webhook.last(FLOW_TYPE, EVENT_TYPE),
      "J-melding event was not emitted",
    );
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      tenant: "jbiskur",
      dataCore: "fishfacts-ai-backend",
      flowType: FLOW_TYPE,
      eventType: EVENT_TYPE,
    });
    expect(event.payload).toMatchObject({
      status: "current",
      jmNumber: "j-1-2026",
    });
    expect((event.payload as { title?: string }).title).toContain(
      "J-1-2026 Testregulering for fisket etter sild",
    );

    const created = usable.calls.find(
      (call) =>
        call.method === "POST" &&
        (call.body as { key?: string } | undefined)?.key ===
          "fishfacts-jmelding-j-1-2026",
    );
    expect(created).toBeDefined();
    expect(created?.body).toMatchObject({
      key: "fishfacts-jmelding-j-1-2026",
      workspaceId: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
      fragmentTypeId: "68505bca-a549-45eb-bca6-965f87195b89",
    });

    webhook.clear();
    await waitFor(async () => {
      const stateResponse = await app.fetch("/api/jobs/state", {
        headers: { "x-auth-token": VALID_AUTH_TOKEN },
      });
      const state = await stateResponse.json();
      return (
        state.state.jobs["fiskeridir-jmeldinger"]?.lastRunStatus === "success"
      );
    }, "Job did not finish before second run");
    for (const [id, fragment] of usable.fragments) {
      if (fragment.tags?.includes("job-system")) usable.fragments.delete(id);
    }
    const secondResponse = await app.fetch("/api/jobs/run", {
      method: "POST",
      headers: { "x-auth-token": VALID_AUTH_TOKEN },
      body: JSON.stringify({
        jobId: "fiskeridir-jmeldinger",
        waitForCompletion: true,
        args: { maxItems: 1, maxPages: 1, includeArchived: true },
      }),
    });
    expect(secondResponse.status).toBe(202);
    await Bun.sleep(200);
    expect(webhook.last(FLOW_TYPE, EVENT_TYPE)).toBeUndefined();
    await waitFor(async () => {
      const stateResponse = await app.fetch("/api/jobs/state", {
        headers: { "x-auth-token": VALID_AUTH_TOKEN },
      });
      const state = await stateResponse.json();
      return state.state.jobs["fiskeridir-jmeldinger"]?.progress
        ?.skippedExisting;
    }, "Job did not skip existing Usable fragments");
  });

  test("replayed event updates same Usable key", async () => {
    const payload = fixtureAnnouncementPayload();
    const patchCountBefore = usable.calls.filter(
      (call) => call.method === "PATCH",
    ).length;

    const response = await app.fetch("/api/transformer", {
      method: "POST",
      headers: { "x-secret": TRANSFORMER_SECRET },
      body: JSON.stringify({
        eventId: "eeeeeeee-1111-4111-8111-111111111111",
        timeBucket: "20260101000000",
        tenant: "jbiskur",
        dataCoreId: "fishfacts-ai-backend",
        flowType: FLOW_TYPE,
        eventType: EVENT_TYPE,
        validTime: new Date().toISOString(),
        metadata: {},
        payload,
      }),
    });

    expect(response.status).toBe(200);
    const patchCountAfter = usable.calls.filter(
      (call) => call.method === "PATCH",
    ).length;
    expect(patchCountAfter).toBeGreaterThan(patchCountBefore);
  });

  test("chunked transformer events are queued and reassembled into a single fragment", async () => {
    const chunkedKey = "fishfacts-jmelding-j-9999-chunked";
    const chunkedUrl = `http://127.0.0.1:${FISKERIDIR_PORT}/yrkesfiske/j-meldinger/j-9999-chunked`;
    const chunkedSignature = `signature-chunked-${Date.now()}`;
    const totalParts = 3;
    const chunkBody = (marker: string) => marker.repeat(15_000);
    const chunks = [
      { partNumber: 1, body: chunkBody("A") },
      { partNumber: 2, body: chunkBody("B") },
      { partNumber: 3, body: chunkBody("C") },
    ];
    for (const [id, fragment] of usable.fragments) {
      if (fragment.key === chunkedKey) usable.fragments.delete(id);
    }

    for (const chunk of chunks) {
      const response = await app.fetch("/api/transformer", {
        method: "POST",
        headers: { "x-secret": TRANSFORMER_SECRET },
        body: JSON.stringify({
          eventId: `chunked-${chunk.partNumber}-${chunkedSignature}`,
          timeBucket: "20260101000000",
          tenant: "jbiskur",
          dataCoreId: "fishfacts-ai-backend",
          flowType: FLOW_TYPE,
          eventType: EVENT_TYPE,
          validTime: new Date().toISOString(),
          metadata: {},
          payload: {
            signature: chunkedSignature,
            title: "J-9999-Chunked Test announcement",
            url: chunkedUrl,
            status: "current",
            jmNumber: "j-9999-chunked",
            bodyMarkdown: chunk.body,
            checkedAt: new Date().toISOString(),
            partNumber: chunk.partNumber,
            totalParts,
          },
        }),
      });
      expect(response.status).toBe(200);
    }

    const projected = Array.from(usable.fragments.values()).find(
      (fragment) => fragment.key === chunkedKey,
    );
    expect(projected).toBeDefined();
    expect(projected?.content).toContain("AAAAA");
    expect(projected?.content).toContain("BBBBB");
    expect(projected?.content).toContain("CCCCC");
  });

  test("partial chunked transformer events do not project until all parts arrive", async () => {
    const chunkedKey = "fishfacts-jmelding-j-9998-partial";
    const chunkedUrl = `http://127.0.0.1:${FISKERIDIR_PORT}/yrkesfiske/j-meldinger/j-9998-partial`;
    const chunkedSignature = `signature-partial-${Date.now()}`;
    for (const [id, fragment] of usable.fragments) {
      if (fragment.key === chunkedKey) usable.fragments.delete(id);
    }

    const sendChunk = async (partNumber: number) =>
      app.fetch("/api/transformer", {
        method: "POST",
        headers: { "x-secret": TRANSFORMER_SECRET },
        body: JSON.stringify({
          eventId: `partial-${partNumber}-${chunkedSignature}`,
          timeBucket: "20260101000000",
          tenant: "jbiskur",
          dataCoreId: "fishfacts-ai-backend",
          flowType: FLOW_TYPE,
          eventType: EVENT_TYPE,
          validTime: new Date().toISOString(),
          metadata: {},
          payload: {
            signature: chunkedSignature,
            title: "J-9998-Partial Test announcement",
            url: chunkedUrl,
            status: "current",
            jmNumber: "j-9998-partial",
            bodyMarkdown: "M".repeat(40_000),
            checkedAt: new Date().toISOString(),
            partNumber,
            totalParts: 2,
          },
        }),
      });

    expect((await sendChunk(1)).status).toBe(200);
    expect(
      Array.from(usable.fragments.values()).find(
        (fragment) => fragment.key === chunkedKey,
      ),
    ).toBeUndefined();

    expect((await sendChunk(2)).status).toBe(200);
    const projected = Array.from(usable.fragments.values()).find(
      (fragment) => fragment.key === chunkedKey,
    );
    expect(projected).toBeDefined();
    expect(projected?.content).toContain("MMMMM");
  });

  test("oversize body chunks across multiple events and reassembles into one fragment", async () => {
    fiskeridir.setLargeDetailBody(180_000, "L");
    try {
      for (const [id, fragment] of usable.fragments) {
        if (fragment.tags?.includes("job-system")) usable.fragments.delete(id);
        if (fragment.key === "fishfacts-jmelding-j-1-2026") {
          usable.fragments.delete(id);
        }
      }
      webhook.clear();

      const response = await app.fetch("/api/jobs/run", {
        method: "POST",
        headers: { "x-auth-token": VALID_AUTH_TOKEN },
        body: JSON.stringify({
          jobId: "fiskeridir-jmeldinger",
          waitForCompletion: true,
          args: { maxItems: 1, maxPages: 1, includeArchived: true },
        }),
      });
      expect(response.status).toBe(202);

      await waitFor(async () => {
        const stateResponse = await app.fetch("/api/jobs/state", {
          headers: { "x-auth-token": VALID_AUTH_TOKEN },
        });
        const state = await stateResponse.json();
        return (
          state.state.jobs["fiskeridir-jmeldinger"]?.lastRunStatus === "success"
        );
      }, "Chunked j-melding job did not finish");

      const announcementEvents = webhook.events.filter(
        (event) => event.eventType === EVENT_TYPE,
      );
      expect(announcementEvents.length).toBeGreaterThan(1);

      const partNumbers = announcementEvents.map(
        (event) => (event.payload as { partNumber?: number })?.partNumber,
      );
      expect(new Set(partNumbers).size).toBe(announcementEvents.length);
      const totalParts = (
        announcementEvents[0].payload as { totalParts?: number }
      ).totalParts;
      expect(totalParts).toBe(announcementEvents.length);

      for (const event of announcementEvents) {
        const size = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
        expect(size).toBeLessThanOrEqual(64_000);
        expect(event.metadata).toEqual({
          source: "fiskeridir-jmeldinger-job",
        });
      }

      const projected = Array.from(usable.fragments.values()).find(
        (fragment) => fragment.key === "fishfacts-jmelding-j-1-2026",
      );
      expect(projected).toBeDefined();
      expect(projected?.content).toContain("LLLLL");
    } finally {
      fiskeridir.clearLargeDetailBody();
    }
  });

  test("redelivered chunk after assembly does not crash or re-project", async () => {
    const chunkedKey = "fishfacts-jmelding-j-9997-redeliver";
    const chunkedUrl = `http://127.0.0.1:${FISKERIDIR_PORT}/yrkesfiske/j-meldinger/j-9997-redeliver`;
    const chunkedSignature = `signature-redeliver-${Date.now()}`;
    for (const [id, fragment] of usable.fragments) {
      if (fragment.key === chunkedKey) usable.fragments.delete(id);
    }

    const sendChunk = async (partNumber: number) =>
      app.fetch("/api/transformer", {
        method: "POST",
        headers: { "x-secret": TRANSFORMER_SECRET },
        body: JSON.stringify({
          eventId: `redeliver-${partNumber}-${chunkedSignature}`,
          timeBucket: "20260101000000",
          tenant: "jbiskur",
          dataCoreId: "fishfacts-ai-backend",
          flowType: FLOW_TYPE,
          eventType: EVENT_TYPE,
          validTime: new Date().toISOString(),
          metadata: {},
          payload: {
            signature: chunkedSignature,
            title: "J-9997-Redeliver Test announcement",
            url: chunkedUrl,
            status: "current",
            jmNumber: "j-9997-redeliver",
            bodyMarkdown: "R".repeat(15_000),
            checkedAt: new Date().toISOString(),
            partNumber,
            totalParts: 2,
          },
        }),
      });

    expect((await sendChunk(1)).status).toBe(200);
    expect((await sendChunk(2)).status).toBe(200);
    const projected = Array.from(usable.fragments.values()).find(
      (fragment) => fragment.key === chunkedKey,
    );
    expect(projected).toBeDefined();
    const callsAfterAssembly = usable.calls.length;

    const replay = await sendChunk(1);
    expect(replay.status).toBe(200);
    const stillOne = Array.from(usable.fragments.values()).filter(
      (fragment) => fragment.key === chunkedKey,
    );
    expect(stillOne.length).toBe(1);
    expect(usable.calls.length).toBe(callsAfterAssembly);
  });

  test("invalid transformer secret is rejected", async () => {
    const response = await app.fetch("/api/transformer", {
      method: "POST",
      headers: { "x-secret": "wrong" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
