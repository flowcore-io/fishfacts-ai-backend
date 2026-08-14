import { afterEach, describe, expect, test } from "bun:test";
import { FishfactsVesselDirectory } from "../../src/fishfacts/vessel-directory";

type ServedVessel = {
  id: number;
  name: string;
  registrationNumber: string;
};

const VESSELS: ServedVessel[] = [
  { id: 932, name: "Brattskjær", registrationNumber: "TR-0346-ND" },
  { id: 77, name: "Fiskebas", registrationNumber: "FO-123" },
  // A duplicate NAME across two ids: the registry is not guaranteed unique.
  { id: 78, name: "Fiskebas", registrationNumber: "FO-999" },
];

let server: ReturnType<typeof Bun.serve> | null = null;

function serveRegistry(
  handler: (request: Request) => Response | Promise<Response>,
) {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
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

describe("FishfactsVesselDirectory", () => {
  test("resolves by name, then by registration mark", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve("Brattskjær", null)).toBe(932);
    // Name is unknown here, so the registration mark decides.
    expect(await directory.resolve("Ukjent", "TR-0346-ND")).toBe(932);
    // Case and padding are normalised the same way the FE normalises them.
    expect(await directory.resolve("  brattskjær ", null)).toBe(932);
  });

  test("an ambiguous name resolves to null rather than an arbitrary vessel", async () => {
    const baseUrl = serveRegistry(
      () => new Response(JSON.stringify({ data: VESSELS })),
    );
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    // "Fiskebas" is two vessels: picking one would attach a stranger's track.
    expect(await directory.resolve("Fiskebas", null)).toBeNull();
    // The registration mark disambiguates it.
    expect(await directory.resolve("Fiskebas", "FO-999")).toBe(78);
  });

  test("the registry is fetched once and cached, not per report", async () => {
    let calls = 0;
    const baseUrl = serveRegistry(() => {
      calls += 1;
      return new Response(JSON.stringify(VESSELS));
    });
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    await Promise.all([
      directory.resolve("Brattskjær", null),
      directory.resolve("Brattskjær", null),
    ]);
    await directory.resolve("Brattskjær", null);

    expect(calls).toBe(1);
  });

  test("without a service token it resolves nothing and calls nothing", async () => {
    let calls = 0;
    const baseUrl = serveRegistry(() => {
      calls += 1;
      return new Response(JSON.stringify(VESSELS));
    });
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl));

    expect(await directory.resolve("Brattskjær", "TR-0346-ND")).toBeNull();
    expect(calls).toBe(0);
  });

  test("an upstream failure resolves to null rather than throwing", async () => {
    const baseUrl = serveRegistry(() => new Response("nope", { status: 500 }));
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve("Brattskjær", null)).toBeNull();
  });

  test("a report with neither name nor mark never hits the registry", async () => {
    let calls = 0;
    const baseUrl = serveRegistry(() => {
      calls += 1;
      return new Response(JSON.stringify(VESSELS));
    });
    const directory = new FishfactsVesselDirectory(makeEnv(baseUrl, "tok"));

    expect(await directory.resolve(null, "   ")).toBeNull();
    expect(calls).toBe(0);
  });
});
