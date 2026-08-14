import { afterEach, describe, expect, test } from "bun:test";
import { FishfactsVesselDirectory } from "../../src/fishfacts/vessel-directory";

/**
 * Records shaped like the live registry: `GET /api/v3/vessels` answers
 * `{ code, errors, message, data: VesselResponse[] }`, and a record carries
 * `id`, `flag`, `name`, `vesselType` and `registrationNumber` — the last of
 * which is NULLABLE on real data.
 */
const VESSELS = [
  {
    id: 932,
    flag: "NO",
    name: "Brattskjær",
    registrationNumber: "TR-0346-ND",
    vesselType: { id: 1, supportedApps: ["FISHFACTS"] },
  },
  {
    id: 77,
    flag: "FO",
    name: "Fiskebas",
    registrationNumber: "FO-123",
    vesselType: { id: 1, supportedApps: ["FISHFACTS"] },
  },
  // Same NAME, different id — ~1.2% of registry names are like this.
  {
    id: 78,
    flag: "FO",
    name: "Fiskebas",
    registrationNumber: "FO-999",
    vesselType: { id: 1, supportedApps: ["FISHFACTS"] },
  },
  // Live sample record: a registry entry with NO registration number.
  {
    id: 7,
    flag: "GL",
    name: "Tasiilaq",
    registrationNumber: null,
    vesselType: { id: 2, supportedApps: ["AQUAFACTS"] },
  },
];

let server: ReturnType<typeof Bun.serve> | null = null;
let requests: Array<{
  path: string;
  token: string | null;
  app: string | null;
}> = [];

function serveRegistry(
  handler: (request: Request) => Response | Promise<Response>,
) {
  requests = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        token: request.headers.get("x-auth-token"),
        app: request.headers.get("x-application"),
      });
      return handler(request);
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function makeEnv(baseUrl: string, token?: string) {
  return {
    FISHFACTS_API_BASE_URL: baseUrl,
    FISHFACTS_APPLICATION: "FISHFACTS",
    FISHFACTS_SERVICE_TOKEN: token,
    FISHFACTS_VESSEL_CACHE_TTL_MS: 3_600_000,
    // biome-ignore lint/suspicious/noExplicitAny: env stub for the directory.
  } as any;
}

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("FishfactsVesselDirectory — the endpoint", () => {
  test("reads the PLURAL registry path, with the token and X-Application", async () => {
    // The singular /api/v3/vessel is not the registry: FishFacts' OpenAPI
    // declares no GET on it, and calling it with a valid session answers 500.
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    await directory.resolve("Brattskjær", null);

    expect(requests[0]?.path).toBe("/api/v3/vessels");
    expect(requests[0]?.token).toBe("tok");
    expect(requests[0]?.app).toBe("FISHFACTS");
  });

  test("reads the wrapped payload FishFacts actually returns", async () => {
    const baseUrl = serveRegistry(
      () =>
        new Response(
          JSON.stringify({ code: 0, errors: [], message: "", data: VESSELS }),
        ),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve("Brattskjær", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });
});

describe("FishfactsVesselDirectory — matching", () => {
  test("resolves by name, then by the report's registration mark", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve("Brattskjær", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
    // The report's `registrationMark` matches the registry's
    // `registrationNumber` — reading `registrationMark` off a registry record
    // would miss every time.
    expect(await directory.resolve("Ukjent", "TR-0346-ND")).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
    expect(await directory.resolve("  brattskjær ", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });

  test("a registry entry with no registration never matches a report with none", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    // Tasiilaq's registrationNumber is null. An empty mark on the report must
    // not collide with it — null does not equal null here.
    expect(await directory.resolve("Ukjent skip", "")).toEqual({
      outcome: "not-found",
    });
    expect(await directory.resolve("Ukjent skip", "   ")).toEqual({
      outcome: "not-found",
    });
    // The vessel is still resolvable by name.
    expect(await directory.resolve("Tasiilaq", null)).toEqual({
      outcome: "resolved",
      vesselId: 7,
    });
  });

  test("an ambiguous name is not-found, never an arbitrary pick", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve("Fiskebas", null)).toEqual({
      outcome: "not-found",
    });
    // The registration mark disambiguates it.
    expect(await directory.resolve("Fiskebas", "FO-999")).toEqual({
      outcome: "resolved",
      vesselId: 78,
    });
  });

  test("a report with neither name nor mark is not-found, and asks nobody", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve(null, "   ")).toEqual({
      outcome: "not-found",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("FishfactsVesselDirectory — availability is not an answer", () => {
  test("no service token ⇒ unavailable, NOT not-found", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl));

    const lookup = await directory.resolve("Brattskjær", "TR-0346-ND");
    // Reported as not-found, this would be stored as a terminal "no-vessel"
    // for every report in the window on the service's first run.
    expect(lookup.outcome).toBe("unavailable");
    expect(requests).toHaveLength(0);
  });

  test("an HTTP failure is unavailable", async () => {
    const baseUrl = serveRegistry(() => new Response("nope", { status: 500 }));
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect((await directory.resolve("Brattskjær", null)).outcome).toBe(
      "unavailable",
    );
  });

  test("a 401 is unavailable — a bad token says nothing about a vessel", async () => {
    const baseUrl = serveRegistry(() => new Response("", { status: 401 }));
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "stale"));

    expect((await directory.resolve("Brattskjær", null)).outcome).toBe(
      "unavailable",
    );
  });

  test("an unexpected payload shape is unavailable, not an empty fleet", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ vessels: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect((await directory.resolve("Brattskjær", null)).outcome).toBe(
      "unavailable",
    );
  });

  test("a later outage keeps serving the registry already read", async () => {
    let healthy = true;
    const baseUrl = serveRegistry(() =>
      healthy
        ? new Response(JSON.stringify({ data: VESSELS }))
        : new Response("", { status: 503 }),
    );
    const env = makeEnv(baseUrl, "tok");
    env.FISHFACTS_VESSEL_CACHE_TTL_MS = 1;
    const directory = new FishfactsVesselDirectory(env);

    expect((await directory.resolve("Brattskjær", null)).outcome).toBe(
      "resolved",
    );
    healthy = false;
    await Bun.sleep(5);
    // Stale but true beats "we cannot say".
    expect(await directory.resolve("Brattskjær", null)).toEqual({
      outcome: "resolved",
      vesselId: 932,
    });
  });
});

describe("FishfactsVesselDirectory — cost", () => {
  test("the 11k-record registry is fetched once, not once per report", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    // Concurrent first calls must share one in-flight fetch, not race into
    // several: the job resolves a whole batch of reports at once.
    await Promise.all([
      directory.resolve("Brattskjær", null),
      directory.resolve("Fiskebas", "FO-123"),
      directory.resolve("Tasiilaq", null),
    ]);
    await directory.resolve("Brattskjær", null);

    expect(requests).toHaveLength(1);
  });
});
