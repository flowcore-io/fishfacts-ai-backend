import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type { RegulationRevisionProposed } from "../../src/events/contracts";
import type { PathwayWriter } from "../../src/pathways";
import type { PoiEntry } from "../../src/poi/repository";
import type { RegulationQueueReadRepository } from "../../src/regulations/read-repository";
import { createRegulationsRouter } from "../../src/regulations/routes";

const CASE_ID = "b52ba6c8-2ee0-8f9a-8bd7-6a4d29e0f7c3";
const CURRENT_REV = "0aa1b2c3-d4e5-8f01-8234-56789abcdef0";

/** Two enumerated vertices in the NO grammar `parseJmeldingGeo` reads. */
const SNAPSHOT_WITH_COORDINATES = `
Det er forbudt å fiske i et område avgrenset av rette linjer mellom:
1. Nord 71 grader 10,000 minutter. Øst 024 grader 53,000 minutter.
2. Nord 71 grader 11,600 minutter. Øst 024 grader 53,700 minutter.
3. Nord 71 grader 12,600 minutter. Øst 024 grader 58,400 minutter.
`;

const POIS: PoiEntry[] = [
  {
    key: "skarvenes_lykt",
    lat: 70.9012,
    lng: 26.7345,
    title: "Skarvenes lykt (minor light, Finnmark)",
    aliases: ["Skarvenes light"],
  },
  {
    key: "mykines_holmur",
    lat: 62.1,
    lng: -7.68,
    title: "Mykineshólmur",
    aliases: ["Mykines holm"],
  },
];

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
  "user-token": userOf("deckhand", ["USER"]),
};

function makeApp(
  opts: {
    snapshotText?: string | null;
    currentGeometries?: Array<{
      name: string | null;
      points: Array<{ lat: number; lon: number }>;
    }>;
    startJobError?: Error;
  } = {},
) {
  const written: RegulationRevisionProposed[] = [];
  const startJobCalls: Array<{ jobId: string; args: unknown }> = [];
  const queue = {
    getCaseRef: async (id: string) =>
      id === CASE_ID ? { id: CASE_ID, caseKey: "test-source:test-ban" } : null,
    getCaseRow: async (id: string) =>
      id === CASE_ID
        ? {
            id: CASE_ID,
            caseKey: "test-source:test-ban",
            currentRevisionId: CURRENT_REV,
            title: "Test ban",
            authority: null,
            regulationNumber: null,
            category: null,
            summary: null,
            effectiveFrom: null,
            effectiveTo: null,
            expiresAt: null,
            seasonalRecurrence: null,
            interpretationNotes: null,
            applicability: null,
          }
        : null,
    getRevision: async (id: string) =>
      id === CURRENT_REV
        ? {
            id: CURRENT_REV,
            caseId: CASE_ID,
            position: 0,
            snapshotText:
              opts.snapshotText === undefined
                ? SNAPSHOT_WITH_COORDINATES
                : opts.snapshotText,
          }
        : null,
    getRevisionGeometries: async () =>
      (opts.currentGeometries ?? []).map((geometry, index) => ({
        id: `geom-${index}`,
        position: index,
        section: null,
        kind: "closure",
        season: null,
        verticesQuoted: null,
        geometrySource: "preparsed",
        coordinateSystem: "WGS84",
        precision: null,
        geometryValidated: false,
        ...geometry,
      })),
  } as unknown as RegulationQueueReadRepository;
  const writer = {
    writeRegulationRevisionProposed: async (d: RegulationRevisionProposed) => {
      written.push(d);
      return "event-reparse";
    },
  } as unknown as PathwayWriter;
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
      poi: { list: async () => POIS } as never,
      jobRunner: {
        startJob: async (jobId: string, _trigger: string, args: unknown) => {
          if (opts.startJobError) throw opts.startJobError;
          startJobCalls.push({ jobId, args });
          return { promise: Promise.resolve() };
        },
      } as never,
    }),
  );
  return { app, written, startJobCalls };
}

function request(
  app: Hono,
  path: string,
  init: RequestInit = {},
  token: string | null = "admin-token",
) {
  return app.request(`/api/regulations${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-auth-token": token } : {}),
    },
  });
}

describe("GET /api/regulations/landmarks", () => {
  test("matches accent- and case-insensitively across key, title and aliases", async () => {
    const { app } = makeApp();
    const byTitle = await request(app, "/landmarks?q=mykineshólmur");
    expect(byTitle.status).toBe(200);
    expect((await byTitle.json()).matches.map((m: PoiEntry) => m.key)).toEqual([
      "mykines_holmur",
    ]);

    // Stripped accents from the query side too.
    const stripped = await request(app, "/landmarks?q=mykinesholmur");
    expect((await stripped.json()).returned).toBe(1);

    const byAlias = await request(app, "/landmarks?q=skarvenes LIGHT");
    expect((await byAlias.json()).matches[0]?.key).toBe("skarvenes_lykt");
  });

  test("a too-short query is a 400", async () => {
    const { app } = makeApp();
    expect((await request(app, "/landmarks?q=m")).status).toBe(400);
    expect((await request(app, "/landmarks")).status).toBe(400);
  });

  test("no match is an empty list, not an error", async () => {
    const { app } = makeApp();
    const res = await request(app, "/landmarks?q=atlantis");
    expect(res.status).toBe(200);
    expect((await res.json()).returned).toBe(0);
  });
});

describe("POST /api/regulations/cases/:id/reverdict", () => {
  test("starts the verdict job scoped to this case's key", async () => {
    const { app, startJobCalls } = makeApp();
    const res = await request(app, `/cases/${CASE_ID}/reverdict`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(startJobCalls).toEqual([
      {
        jobId: "regulation-verdict",
        args: { caseKeys: ["test-source:test-ban"], limit: 1 },
      },
    ]);
  });

  test("a verdict job already running is a 409, unknown case a 404", async () => {
    const busy = makeApp({
      startJobError: new Error("Job regulation-verdict is already running"),
    });
    const res = await request(busy.app, `/cases/${CASE_ID}/reverdict`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("verdict_job_running");

    const { app } = makeApp();
    expect(
      (
        await request(
          app,
          "/cases/00000000-0000-8000-8000-000000000000/reverdict",
          { method: "POST" },
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /api/regulations/cases/:id/reparse", () => {
  test("proposes a revision from the stored snapshot with the parsed areas", async () => {
    const { app, written } = makeApp({
      currentGeometries: [{ name: null, points: [{ lat: 1, lon: 1 }] }],
    });
    const res = await request(app, `/cases/${CASE_ID}/reparse`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.outcome).toBe("proposed");
    expect(body.areasParsed).toBe(1);
    const event = written[0];
    expect(event?.changes[0]?.field).toBe("geometries");
    expect(event?.geometries[0]?.points).toHaveLength(3);
    expect(event?.geometries[0]?.geometrySource).toBe("enumerated");
    expect(event?.actor).toBe("admin:gilli");
    expect(event?.baseRevisionId).toBe(CURRENT_REV);
    // Fields ride along unchanged — this proposal is about geometry only.
    expect(event?.fields.title).toBe("Test ban");
  });

  test("an identical parse is a no_change, not an empty revision", async () => {
    const probe = makeApp({
      currentGeometries: [{ name: null, points: [{ lat: 1, lon: 1 }] }],
    });
    await request(probe.app, `/cases/${CASE_ID}/reparse`, { method: "POST" });
    const parsedPoints = probe.written[0]?.geometries[0]?.points;
    if (!parsedPoints) throw new Error("probe run produced no geometry");

    const { app, written } = makeApp({
      currentGeometries: [{ name: null, points: parsedPoints }],
    });
    const res = await request(app, `/cases/${CASE_ID}/reparse`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("no_change");
    expect(written).toHaveLength(0);
  });

  test("a case without a stored snapshot is a 422", async () => {
    const { app } = makeApp({ snapshotText: null });
    const res = await request(app, `/cases/${CASE_ID}/reparse`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_snapshot_text");
  });
});

describe("B4 routes auth", () => {
  test("401 without token, 403 without ADMIN", async () => {
    const { app } = makeApp();
    const paths: Array<[string, string]> = [
      ["/landmarks?q=mykines", "GET"],
      [`/cases/${CASE_ID}/reverdict`, "POST"],
      [`/cases/${CASE_ID}/reparse`, "POST"],
    ];
    for (const [path, method] of paths) {
      expect((await request(app, path, { method }, null)).status).toBe(401);
      expect((await request(app, path, { method }, "user-token")).status).toBe(
        403,
      );
    }
  });
});
