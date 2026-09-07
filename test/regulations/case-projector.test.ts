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

  // Veiðibann nr. 14/2026, the case the "no hidden magic" principle was
  // ratified on. Vørn types vertices as DDMM digit runs; `fo` is the same
  // arithmetic the scraper does when it puts them on the announcement event.
  const fo = (latD: number, latM: number, lonD: number, lonM: number) => ({
    lat: latD + latM / 60,
    lon: -(lonD + lonM / 60),
  });
  const NR14_BODY =
    "Við heimild í Løgtingslóg nr. 152 frá 23. desember 2019, § 59, ásetir Fiskiveiðueftirlitið bráðfeingis veiðibann fyri trol, á eini leið í vestara kanti á Munkagrunninum. 6104 N – 0700 W 6057 N – 0706 W 6045 N – 0700 W 6039 N – 0654 W 6045 N – 0636 W 6014 N – 0700 W Veiðibannið er galdandi frá í dag, hin 1. juli 2026 klokkan 23:00 til 29. juli 2026 klokkan 23:00.";
  const NR14_RING = [
    fo(61, 4, 7, 0),
    fo(60, 57, 7, 6),
    fo(60, 45, 7, 0),
    fo(60, 39, 6, 54),
    fo(60, 45, 6, 36),
    fo(60, 14, 7, 0), // the fat-fingered 6104 → 6014, ~93 km too far south
  ];

  test("a Vørn ring is stored AS WRITTEN — the typo'd vertex reaches the reviewer", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const ban = makeItem("test-vorn-14-2026", {
      signature: "sig-test-vorn-14-2026-v1",
      region: "FO",
      bodyMarkdown: NR14_BODY,
      areas: [{ name: null, points: NR14_RING }],
    });

    const result = await projector.project(ban);
    expect(result.outcome).toBe("created");
    expect(result.caseKey).toBe("vorn-veidibann:test-vorn-14-2026");

    const [geometry] = await runCtx.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.caseId, result.caseId));
    // Six, not the repaired five: making that repair is the judgment call the
    // queue exists to hand a human, so the map has to draw the spike.
    expect(geometry?.points).toEqual(NR14_RING);

    // And the deterministic re-parse of the stored snapshot agrees with it —
    // the property that keeps an admin re-parse from proposing a change that
    // is really just the two readers disagreeing.
    const [revision] = await runCtx.db
      .select()
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.id, result.revisionId));
    expect(revision?.snapshotText).toBeTruthy();
    if (!revision?.snapshotText) return;
    expect(parseJmeldingGeo(revision.snapshotText).areas[0]?.points).toEqual(
      NR14_RING,
    );
  });

  test("Vørn's repeated closing vertex is still dropped — that much is convention", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const first = fo(62, 39, 5, 51);
    const ban = makeItem("test-vorn-10-2026", {
      signature: "sig-test-vorn-10-2026-v1",
      region: "FO",
      bodyMarkdown: "6239 N – 0551 W 6230 N – 0600 W 6239 N – 0551 W",
      areas: [{ name: null, points: [first, fo(62, 30, 6, 0), first] }],
    });

    const result = await projector.project(ban);
    const [geometry] = await runCtx.db
      .select()
      .from(schema.regulationCaseGeometries)
      .where(eq(schema.regulationCaseGeometries.caseId, result.caseId));
    // The point is not lost by dropping the repeat — it is still the ring's
    // first vertex, which is why this one cleanup invents nothing.
    expect(geometry?.points).toEqual([first, fo(62, 30, 6, 0)]);
  });

  test("a Lógasavn statute keeps its fragment pointer as the snapshot reference", async () => {
    if (!runCtx) return;
    const projector = new RegulationCaseProjector(runCtx.db);
    const statute = makeItem("LOG-K-test-45-2022", {
      signature: "sig-log-k-test-45-2022-v1",
      region: "FO",
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
    });

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
