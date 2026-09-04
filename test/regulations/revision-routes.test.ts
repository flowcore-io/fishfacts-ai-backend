import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../../src/auth/types";
import type {
  RegulationApprovalRecorded,
  RegulationRevisionPointerMoved,
  RegulationRevisionProposed,
  RegulationValidationRecorded,
} from "../../src/events/contracts";
import type { PathwayWriter } from "../../src/pathways";
import type { RegulationQueueReadRepository } from "../../src/regulations/read-repository";
import { createRegulationsRouter } from "../../src/regulations/routes";

const CASE_ID = "b52ba6c8-2ee0-8f9a-8bd7-6a4d29e0f7c3";
const CURRENT_REV = "0aa1b2c3-d4e5-8f01-8234-56789abcdef0";
const OLD_REV = "1bb2c3d4-e5f6-8012-8345-6789abcdef01";
const GEOMETRY_ID = "2cc3d4e5-f6a7-8123-8456-789abcdef012";

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

const CASE_ROW = {
  id: CASE_ID,
  caseKey: "test-source:test-ban",
  currentRevisionId: CURRENT_REV,
  regulatoryValidated: false,
  geometryValidated: false,
  title: "Original title",
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
};

const BASE_GEOMETRY = {
  id: GEOMETRY_ID,
  position: 0,
  name: "Area A",
  section: null,
  kind: "closure",
  season: null,
  verticesQuoted: null,
  points: [{ lat: 62, lon: -6.8 }],
  geometrySource: "enumerated",
  coordinateSystem: "WGS84",
  precision: null,
  geometryValidated: false,
};

type Written = {
  proposed: RegulationRevisionProposed[];
  pointer: RegulationRevisionPointerMoved[];
  validation: RegulationValidationRecorded[];
  approval: RegulationApprovalRecorded[];
};

function makeApp(caseOverrides: Partial<typeof CASE_ROW> = {}) {
  const written: Written = {
    proposed: [],
    pointer: [],
    validation: [],
    approval: [],
  };
  const row = { ...CASE_ROW, ...caseOverrides };
  const queue = {
    getCaseRef: async (id: string) =>
      id === CASE_ID ? { id: CASE_ID, caseKey: row.caseKey } : null,
    getCaseRow: async (id: string) => (id === CASE_ID ? row : null),
    getRevision: async (id: string) =>
      id === CURRENT_REV
        ? { id: CURRENT_REV, caseId: CASE_ID, position: 1 }
        : id === OLD_REV
          ? { id: OLD_REV, caseId: CASE_ID, position: 0 }
          : null,
    listRevisionsSince: async (_caseId: string, position: number) =>
      position < 1
        ? [
            {
              id: CURRENT_REV,
              position: 1,
              author: "admin:gilli",
              changes: [{ field: "title", justification: "fixed" }],
              createdAt: new Date(),
            },
          ]
        : [],
    getRevisionGeometries: async (revisionId: string) =>
      revisionId === CURRENT_REV ? [BASE_GEOMETRY] : [],
  } as unknown as RegulationQueueReadRepository;
  const writer = {
    writeRegulationRevisionProposed: async (d: RegulationRevisionProposed) => {
      written.proposed.push(d);
      return "event-rev";
    },
    writeRegulationRevisionPointerMoved: async (
      d: RegulationRevisionPointerMoved,
    ) => {
      written.pointer.push(d);
      return "event-ptr";
    },
    writeRegulationValidationRecorded: async (
      d: RegulationValidationRecorded,
    ) => {
      written.validation.push(d);
      return "event-val";
    },
    writeRegulationApprovalRecorded: async (d: RegulationApprovalRecorded) => {
      written.approval.push(d);
      return "event-app";
    },
  } as unknown as PathwayWriter;
  const app = new Hono();
  app.use("/api/regulations/*", async (c, next) => {
    const auth = TOKENS[c.req.header("x-auth-token") ?? ""];
    if (!auth) return c.json({ error: "missing_auth_token" }, 401);
    c.set("auth", auth);
    return next();
  });
  app.route("/api/regulations", createRegulationsRouter({ queue, writer }));
  return { app, written };
}

function post(
  app: Hono,
  path: string,
  body: unknown,
  token: string | null = "admin-token",
) {
  return app.request(`/api/regulations/cases/${CASE_ID}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-auth-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

const FIELDS = {
  title: "Amended title",
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
};

describe("B3 routes auth", () => {
  test("401 without token, 403 without ADMIN, on all four routes", async () => {
    const { app } = makeApp();
    const bodies: Array<[string, unknown]> = [
      ["/revisions", { baseRevisionId: CURRENT_REV, fields: FIELDS }],
      ["/revision-pointer", { toRevisionId: OLD_REV }],
      [
        "/validations",
        { revisionId: CURRENT_REV, scope: "legal", validated: true },
      ],
      ["/approval", { revisionId: CURRENT_REV }],
    ];
    for (const [path, body] of bodies) {
      expect((await post(app, path, body, null)).status).toBe(401);
      expect((await post(app, path, body, "user-token")).status).toBe(403);
    }
  });
});

describe("POST /cases/:id/revisions", () => {
  test("emits a self-contained draft: derived changes, inherited geometry, stamped actor", async () => {
    const { app, written } = makeApp();
    const res = await post(app, "/revisions", {
      baseRevisionId: CURRENT_REV,
      fields: FIELDS,
      justifications: { title: "clarified per Gilli" },
    });
    expect(res.status).toBe(202);
    const event = written.proposed[0];
    expect(event?.changes).toEqual([
      { field: "title", justification: "clarified per Gilli" },
    ]);
    // Untouched geometry is copied from the base so the event stands alone.
    expect(event?.geometries).toHaveLength(1);
    expect(event?.geometries[0]?.name).toBe("Area A");
    expect(event?.actor).toBe("admin:gilli");
    expect(event?.baseRevisionId).toBe(CURRENT_REV);
  });

  test("a stale base is a 409 carrying the revisions that superseded it", async () => {
    const { app, written } = makeApp();
    const res = await post(app, "/revisions", {
      baseRevisionId: OLD_REV,
      fields: FIELDS,
      justifications: { title: "late edit" },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("stale_revision");
    expect(body.currentRevisionId).toBe(CURRENT_REV);
    expect(body.revisionsSince).toHaveLength(1);
    expect(written.proposed).toHaveLength(0);
  });

  test("no changes → 400; a changed field without justification → 400; a justification for an unchanged field → 400", async () => {
    const { app } = makeApp();
    const unchanged = { ...FIELDS, title: "Original title" };
    const noChanges = await post(app, "/revisions", {
      baseRevisionId: CURRENT_REV,
      fields: unchanged,
    });
    expect(noChanges.status).toBe(400);
    expect((await noChanges.json()).reason).toBe("no_changes");

    const missing = await post(app, "/revisions", {
      baseRevisionId: CURRENT_REV,
      fields: FIELDS,
    });
    expect(missing.status).toBe(400);
    const missingBody = await missing.json();
    expect(missingBody.reason).toBe("missing_justification");
    expect(missingBody.fields).toEqual(["title"]);

    const unexplained = await post(app, "/revisions", {
      baseRevisionId: CURRENT_REV,
      fields: FIELDS,
      justifications: { title: "ok", summary: "never changed" },
    });
    expect(unexplained.status).toBe(400);
    expect((await unexplained.json()).reason).toBe(
      "justification_for_unchanged_field",
    );
  });

  test("replacing geometry needs its own justification", async () => {
    const { app, written } = makeApp();
    const geometries = [
      { ...BASE_GEOMETRY, id: undefined, points: [{ lat: 62.5, lon: -6.5 }] },
    ];
    const refused = await post(app, "/revisions", {
      baseRevisionId: CURRENT_REV,
      fields: { ...FIELDS, title: "Original title" },
      geometries,
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).fields).toEqual(["geometries"]);

    const ok = await post(app, "/revisions", {
      baseRevisionId: CURRENT_REV,
      fields: { ...FIELDS, title: "Original title" },
      geometries,
      justifications: { geometries: "vertex 3 was transcribed wrong" },
    });
    expect(ok.status).toBe(202);
    expect(written.proposed[0]?.changes).toEqual([
      { field: "geometries", justification: "vertex 3 was transcribed wrong" },
    ]);
  });
});

describe("POST /cases/:id/revision-pointer", () => {
  test("moves to a revision of this case; refuses foreign revisions", async () => {
    const { app, written } = makeApp();
    const ok = await post(app, "/revision-pointer", { toRevisionId: OLD_REV });
    expect(ok.status).toBe(202);
    expect(written.pointer[0]?.toRevisionId).toBe(OLD_REV);

    const foreign = await post(app, "/revision-pointer", {
      toRevisionId: "9ff9d4e5-f6a7-8123-8456-789abcdef099",
    });
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).reason).toBe("revision_not_of_case");
  });
});

describe("POST /cases/:id/validations", () => {
  test("legal validation of the current revision passes through", async () => {
    const { app, written } = makeApp();
    const res = await post(app, "/validations", {
      revisionId: CURRENT_REV,
      scope: "legal",
      validated: true,
      note: "matches Lógasavn text",
    });
    expect(res.status).toBe(202);
    expect(written.validation[0]).toMatchObject({
      scope: "legal",
      geometryId: null,
      validated: true,
      actor: "admin:gilli",
    });
  });

  test("validating a superseded revision is a 409 with the diff", async () => {
    const { app } = makeApp();
    const res = await post(app, "/validations", {
      revisionId: OLD_REV,
      scope: "legal",
      validated: true,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("stale_revision");
  });

  test("geometry scope needs a geometryId belonging to the revision", async () => {
    const { app } = makeApp();
    const missingId = await post(app, "/validations", {
      revisionId: CURRENT_REV,
      scope: "geometry",
      validated: true,
    });
    expect(missingId.status).toBe(400);

    const foreign = await post(app, "/validations", {
      revisionId: CURRENT_REV,
      scope: "geometry",
      geometryId: "9ff9d4e5-f6a7-8123-8456-789abcdef099",
      validated: true,
    });
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).reason).toBe("geometry_not_of_revision");

    const legalWithGeometry = await post(app, "/validations", {
      revisionId: CURRENT_REV,
      scope: "legal",
      geometryId: GEOMETRY_ID,
      validated: true,
    });
    expect(legalWithGeometry.status).toBe(400);
  });
});

describe("POST /cases/:id/approval", () => {
  test("refuses until both validations hold, then approves the named revision", async () => {
    const unvalidated = makeApp();
    const refused = await post(unvalidated.app, "/approval", {
      revisionId: CURRENT_REV,
    });
    expect(refused.status).toBe(422);
    expect((await refused.json()).missing).toEqual(["legal", "geometry"]);

    const validated = makeApp({
      regulatoryValidated: true,
      geometryValidated: true,
    });
    const ok = await post(validated.app, "/approval", {
      revisionId: CURRENT_REV,
    });
    expect(ok.status).toBe(202);
    expect(validated.written.approval[0]).toMatchObject({
      revisionId: CURRENT_REV,
      metadataOnly: false,
      actor: "admin:gilli",
    });
  });

  test("metadataOnly needs only the legal validation", async () => {
    const { app, written } = makeApp({ regulatoryValidated: true });
    const res = await post(app, "/approval", {
      revisionId: CURRENT_REV,
      metadataOnly: true,
    });
    expect(res.status).toBe(202);
    expect(written.approval[0]?.metadataOnly).toBe(true);
  });

  test("approving a superseded revision is a 409 carrying the diff", async () => {
    const { app, written } = makeApp({
      regulatoryValidated: true,
      geometryValidated: true,
    });
    const res = await post(app, "/approval", { revisionId: OLD_REV });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("stale_revision");
    expect(body.currentRevisionId).toBe(CURRENT_REV);
    expect(body.revisionsSince.length).toBeGreaterThan(0);
    expect(written.approval).toHaveLength(0);
  });
});
