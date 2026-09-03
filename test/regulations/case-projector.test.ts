import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type { JMeldingAnnouncementDiscovered } from "../../src/events/contracts";
import { parseJmeldingGeo } from "../../src/jmelding/geo-parser";
import {
  RegulationCaseProjector,
  sourceTypeOf,
} from "../../src/regulations/case-projector";
import { caseIdFor, revisionIdFor } from "../../src/regulations/ids";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_geometries WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE '%test-%')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE '%test-%')`;
  await client`DELETE FROM regulation_case_sources WHERE source_ref LIKE '%test-%'`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE '%test-%'`;
}

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await cleanup(client);
  return { db, client };
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[case-projector.test] skipping — could not connect to test PostGIS DB",
      error instanceof Error ? error.message : error,
    );
    runCtx = null;
  }
});

afterAll(async () => {
  if (runCtx) {
    await cleanup(runCtx.client);
    await runCtx.client.end();
  }
});

/** A Norwegian body `parseJmeldingGeo` reads — the round-trip test depends on
 * the snapshot alone being enough to reproduce the geometry. */
const NO_BODY = `
Det er forbudt å fiske med snurrevad i et område avgrenset av rette linjer mellom følgende posisjoner:

1. Nord 71 grader 10,000 minutter. Øst 024 grader 53,000 minutter.
2. Nord 71 grader 11,600 minutter. Øst 024 grader 53,700 minutter.
3. Nord 71 grader 12,600 minutter. Øst 024 grader 58,400 minutter.
`;

function makeItem(
  jmNumber: string,
  overrides: Partial<JMeldingAnnouncementDiscovered> = {},
): JMeldingAnnouncementDiscovered {
  return {
    signature: `sig-${jmNumber}-v1`,
    title: `Test ${jmNumber}`,
    url: `https://www.fiskeridir.no/yrkesfiske/j-meldinger/${jmNumber}`,
    status: "current",
    region: "NO",
    jmNumber,
    bodyMarkdown: NO_BODY,
    contentHash: `hash-${jmNumber}-v1`,
    checkedAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

describe("sourceTypeOf", () => {
  test("recognises the four collectors", () => {
    expect(sourceTypeOf(makeItem("test-J-1-2026"))).toBe("fiskeridir-jmelding");
    expect(
      sourceTypeOf(makeItem("test-vorn-1", { region: "FO", areas: [] })),
    ).toBe("vorn-veidibann");
    expect(
      sourceTypeOf(makeItem("test-fiskistofa-a-1", { region: "IS" })),
    ).toBe("fiskistofa-wfs");
    expect(sourceTypeOf(makeItem("LOG-K-test-45-2022", { region: "FO" }))).toBe(
      "logasavn",
    );
    // A statute is recognised by its fragment pointer too — the row key alone
    // must not be the only guard against Vørn-style ring repair.
    expect(
      sourceTypeOf(
        makeItem("test-x", { region: "FO", sourceFragmentId: "frag-1" }),
      ),
    ).toBe("logasavn");
  });
});

describe("RegulationCaseProjector", () => {
  test("creates a case with §4 defaults, a revision and geometry rows", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const item = makeItem("test-J-1-2026");

    const result = await projector.project(item);
    expect(result.outcome).toBe("created");

    const [row] = await runCtx.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, result.caseId));
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.caseKey).toBe("fiskeridir-jmelding:test-J-1-2026");
    expect(row.jurisdiction).toBe("NO");
    // The three axes and two flags start where ingestion must leave them.
    expect(row.regulationStatus).toBe("draft");
    expect(row.adminStatus).toBe("unread");
    expect(row.sourceComparison).toBeNull();
    expect(row.regulatoryValidated).toBe(false);
    expect(row.geometryValidated).toBe(false);
    expect(row.verdictStatus).toBe("pending");
    expect(row.caseType).toBe("ingested");
    expect(row.changeType).toBe("new");
    expect(row.currentRevisionId).toBe(result.revisionId);

    const revisions = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.caseId, result.caseId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.position).toBe(0);
    expect(revisions[0]?.snapshotText).toContain("71 grader 10,000");
    expect(revisions[0]?.parseStatus).toBe("ok");

    const geometries = await runCtx.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.caseId, result.caseId));
    expect(geometries).toHaveLength(1);
    expect(geometries[0]?.geometrySource).toBe("enumerated");
    expect(geometries[0]?.geometryValidated).toBe(false);
    expect((geometries[0]?.points as Array<unknown>).length).toBe(3);

    const sources = await runCtx.db
      .select()
      .from(schema.regulationCaseSources)
      .where(eq(schema.regulationCaseSources.caseId, result.caseId));
    expect(sources).toHaveLength(1);
    expect(sources[0]?.isPrimary).toBe(true);
    expect(sources[0]?.comparison).toBeNull();
  });

  test("geometry re-parses from the stored snapshot alone", async () => {
    if (!runCtx) return;
    const [revision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(
        eq(
          schema.regulationCaseRevisions.id,
          revisionIdFor("sig-test-J-1-2026-v1"),
        ),
      );
    expect(revision?.snapshotText).toBeTruthy();
    if (!revision?.snapshotText) return;

    const reparsed = parseJmeldingGeo(revision.snapshotText);
    const [geometry] = await runCtx.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.revisionId, revision.id));
    expect(reparsed.areas[0]?.points).toEqual(
      geometry?.points as Array<{ lat: number; lon: number }>,
    );
  });

  test("replaying the same signature adds nothing", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const item = makeItem("test-J-1-2026");

    const replay = await projector.project(item);
    expect(replay.outcome).toBe("replayed");

    const revisions = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.caseId, replay.caseId));
    expect(revisions).toHaveLength(1);
  });

  test("changed content appends an addressable revision instead of editing", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const revised = makeItem("test-J-1-2026", {
      signature: "sig-test-J-1-2026-v2",
      contentHash: "hash-test-J-1-2026-v2",
      checkedAt: "2026-09-04T10:00:00.000Z",
    });

    const result = await projector.project(revised);
    expect(result.outcome).toBe("revised");

    const [row] = await runCtx.db
      .select()
      .from(schema.regulationCases)
      .where(eq(schema.regulationCases.id, result.caseId));
    expect(row?.changeType).toBe("amendment");
    expect(row?.contentHash).toBe("hash-test-J-1-2026-v2");
    expect(row?.currentRevisionId).toBe(result.revisionId);
    // A new text invalidates the old verdict.
    expect(row?.verdictStatus).toBe("pending");

    const revisions = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.caseId, result.caseId))
      .orderBy(schema.regulationCaseRevisions.position);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.position).toBe(1);
    expect(revisions[1]?.changeType).toBe("amendment");
    // The first revision — and its geometry — survives untouched, addressable.
    expect(revisions[0]?.contentHash).toBe("hash-test-J-1-2026-v1");
  });

  test("a Lógasavn statute keeps its fragment pointer as the snapshot reference", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const statute = makeItem("LOG-K-test-45-2022", {
      signature: "sig-log-k-test-45-2022-v1",
      region: "FO",
      sourceRef: undefined,
      bodyMarkdown: "",
      sourceFragmentId: "test-fragment-45-2022",
      areas: [
        {
          name: "§ 2, stk. 1, nr. 1",
          points: [
            { lat: 61.666666, lon: -8.416666 },
            { lat: 61.9, lon: -8.666666 },
            { lat: 61.666666, lon: -8.416666 },
          ],
        },
      ],
    } as Partial<JMeldingAnnouncementDiscovered>);

    const result = await projector.project(statute);
    expect(result.outcome).toBe("created");
    expect(result.caseKey).toBe("logasavn:LOG-K-test-45-2022");

    const [revision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, result.revisionId));
    expect(revision?.snapshotText).toBeNull();
    expect(revision?.snapshotFragmentId).toBe("test-fragment-45-2022");

    const geometries = await runCtx.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.caseId, result.caseId));
    expect(geometries).toHaveLength(1);
    expect(geometries[0]?.geometrySource).toBe("preparsed");
    expect(geometries[0]?.name).toBe("§ 2, stk. 1, nr. 1");
  });

  test("an unidentifiable announcement is skipped, not invented", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const result = await projector.project(
      makeItem("test-ignored", {
        jmNumber: undefined,
        status: "unknown",
        signature: "sig-test-unknown-v1",
      }),
    );
    expect(result.outcome).toBe("skipped");
    const rows = await runCtx.db
      .select()
      .from(schema.regulationCases)
      .where(like(schema.regulationCases.caseKey, "%test-ignored%"));
    expect(rows).toHaveLength(0);
  });

  test("deterministic ids survive a rebuild", async () => {
    // Not a database test: the property is that ids are functions of the
    // durable record, so a replay reconstructs identical references.
    expect(caseIdFor("fiskeridir-jmelding:test-J-1-2026")).toBe(
      caseIdFor("fiskeridir-jmelding:test-J-1-2026"),
    );
    expect(revisionIdFor("sig-a")).not.toBe(revisionIdFor("sig-b"));
    expect(caseIdFor("x")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
