import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import type { JMeldingAnnouncementDiscovered } from "../../src/events/contracts";
import { RegulationCaseProjector } from "../../src/regulations/case-projector";
import {
  OfficialAreaRepository,
  contentHashOf,
} from "../../src/regulations/official-area-repository";
import { RegulationQueueReadRepository } from "../../src/regulations/read-repository";

const DATABASE_URL =
  process.env.REGULATION_CASE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

// The `j-9xx-2099` numbers are lower-case because the collector emits them that
// way and `source_ref` stores them as given. The register publishes `J-153-2026`,
// so the lookup below is handed the upper-case form on purpose.
async function cleanup(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM regulation_case_official_areas WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'j-9%-2099')`;
  await client`DELETE FROM regulation_case_geometries WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'j-9%-2099')`;
  await client`DELETE FROM regulation_case_revisions WHERE case_id IN (SELECT id FROM regulation_cases WHERE source_ref LIKE 'j-9%-2099')`;
  await client`DELETE FROM regulation_case_sources WHERE source_ref LIKE 'j-9%-2099'`;
  await client`DELETE FROM regulation_cases WHERE source_ref LIKE 'j-9%-2099'`;
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
      "[official-area-repository.test] skipping — could not connect to test PostGIS DB",
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

// Two named closures, so the case carries "§ 1" and "§ 2" area names.
const BODY = `
### § 1 Lafjorden

Det er forbudt å fiske, avgrenset av rette linjer mellom følgende posisjoner:

- Nord 70 grader 58,8 minutter. Øst 025 grader 20,1 minutter.
- Nord 70 grader 59,6 minutter. Øst 025 grader 23,5 minutter.
- Nord 70 grader 56,5 minutter. Øst 025 grader 41,3 minutter.

### § 2 Tanasnaget

Det er forbudt å fiske, avgrenset av rette linjer mellom følgende posisjoner:

- Nord 70 grader 45,0 minutter. Øst 028 grader 59,9 minutter.
- Nord 70 grader 57,6 minutter. Øst 028 grader 59,9 minutter.
- Nord 70 grader 58,3 minutter. Øst 029 grader 03,0 minutter.
`;

function item(jm: string): JMeldingAnnouncementDiscovered {
  return {
    signature: `sig-${jm}`,
    title: `Test ${jm}`,
    url: `https://www.fiskeridir.no/yrkesfiske/j-meldinger/${jm}`,
    status: "current",
    region: "NO",
    jmNumber: jm,
    bodyMarkdown: BODY,
    contentHash: `hash-${jm}`,
    checkedAt: new Date().toISOString(),
  } as JMeldingAnnouncementDiscovered;
}

const RING = [
  [25.0, 70.0],
  [25.1, 70.0],
  [25.1, 70.1],
  [25.0, 70.0],
];
const SHAPE_A = { type: "Polygon", coordinates: [RING] };
const SHAPE_B = {
  type: "Polygon",
  coordinates: [RING.map(([lon, lat]) => [lon + 0.5, lat])],
};

describe("OfficialAreaRepository", () => {
  test("find, insert, then rewrite only what changed", async () => {
    if (!runCtx) return;
    const { db } = runCtx;
    const projector = new RegulationCaseProjector(db);
    const repo = new OfficialAreaRepository(db);
    const t0 = new Date("2026-09-30T05:00:00Z");
    const t1 = new Date("2026-10-01T05:00:00Z");

    const projected = await projector.project(item("j-901-2099"));
    const found = await repo.findNorwegianCaseIds(["J-901-2099", "J-000-1900"]);
    // Looked up by the lower-cased number the projector stores, and absent
    // numbers simply don't appear.
    expect(found.get("j-901-2099")).toBe(projected.caseId);
    expect(found.has("j-000-1900")).toBe(false);

    const first = await repo.upsert(
      [
        {
          caseId: projected.caseId,
          paragraph: 1,
          name: "Lafjorden",
          geojson: SHAPE_A,
          vertexCount: 4,
        },
      ],
      t0,
    );
    expect(first).toEqual({ inserted: 1, changed: 0, unchanged: 0 });

    // Same shape again: nothing rewritten, but "last seen" moves so staleness
    // stays visible.
    const same = await repo.upsert(
      [
        {
          caseId: projected.caseId,
          paragraph: 1,
          name: "Lafjorden",
          geojson: SHAPE_A,
          vertexCount: 4,
        },
      ],
      t1,
    );
    expect(same).toEqual({ inserted: 0, changed: 0, unchanged: 1 });
    const [afterSame] = await repo.listForCase(projected.caseId);
    expect(afterSame.fetchedAt.toISOString()).toBe(t1.toISOString());
    expect(afterSame.geojson).toEqual(SHAPE_A);

    const changed = await repo.upsert(
      [
        {
          caseId: projected.caseId,
          paragraph: 1,
          name: "Lafjorden",
          geojson: SHAPE_B,
          vertexCount: 4,
        },
      ],
      t1,
    );
    expect(changed).toEqual({ inserted: 0, changed: 1, unchanged: 0 });
    const [afterChange] = await repo.listForCase(projected.caseId);
    expect(afterChange.geojson).toEqual(SHAPE_B);
  });

  test("the content hash depends on the shape alone", () => {
    expect(contentHashOf(SHAPE_A)).toBe(contentHashOf({ ...SHAPE_A }));
    expect(contentHashOf(SHAPE_A)).not.toBe(contentHashOf(SHAPE_B));
  });
});

describe("getCaseDetail — the authority's shapes", () => {
  test("returns them once for the case, and tags each area with its §", async () => {
    if (!runCtx) return;
    const { db } = runCtx;
    const projector = new RegulationCaseProjector(db);
    const repo = new OfficialAreaRepository(db);
    const reader = new RegulationQueueReadRepository(db);

    const projected = await projector.project(item("j-902-2099"));
    await repo.upsert(
      [
        {
          caseId: projected.caseId,
          paragraph: 2,
          name: "Tanasnaget",
          geojson: SHAPE_A,
          vertexCount: 4,
        },
      ],
      new Date(),
    );

    const detail = await reader.getCaseDetail(projected.caseId);
    expect(detail).not.toBeNull();

    // Once, at the top level — not copied into every revision, because a shape
    // can be 500 KB.
    expect(detail?.officialAreas).toHaveLength(1);
    expect(detail?.officialAreas[0].paragraph).toBe(2);
    expect(detail?.officialAreas[0].geojson).toEqual(SHAPE_A);

    const geometries = detail?.revisions.flatMap((r) => r.geometries) ?? [];
    expect(geometries.map((g) => g.paragraph).sort()).toEqual([1, 2]);
    for (const geometry of geometries) {
      expect(geometry).not.toHaveProperty("officialAreas");
    }
  });

  test("a case with no shapes stored gets an empty list, not a missing key", async () => {
    if (!runCtx) return;
    const { db } = runCtx;
    const projector = new RegulationCaseProjector(db);
    const reader = new RegulationQueueReadRepository(db);
    const projected = await projector.project(item("j-903-2099"));
    const detail = await reader.getCaseDetail(projected.caseId);
    expect(detail?.officialAreas).toEqual([]);
  });

  test("a stored shape survives a new revision — it is not part of the revision model", async () => {
    if (!runCtx) return;
    const { db } = runCtx;
    const projector = new RegulationCaseProjector(db);
    const repo = new OfficialAreaRepository(db);
    const projected = await projector.project(item("j-904-2099"));
    await repo.upsert(
      [
        {
          caseId: projected.caseId,
          paragraph: 1,
          name: "Lafjorden",
          geojson: SHAPE_A,
          vertexCount: 4,
        },
      ],
      new Date(),
    );

    // The source changes: a new signature is a new revision.
    await projector.project({
      ...item("j-904-2099"),
      signature: "sig-j-904-2099-v2",
      contentHash: "hash-j-904-2099-v2",
    });
    const revisions = await db
      .select({ id: schema.regulationCaseRevisions.id })
      .from(schema.regulationCaseRevisions)
      .where(eq(schema.regulationCaseRevisions.caseId, projected.caseId));
    expect(revisions.length).toBeGreaterThan(1);

    const stored = await repo.listForCase(projected.caseId);
    expect(stored).toHaveLength(1);
    expect(stored[0].geojson).toEqual(SHAPE_A);
  });
});
