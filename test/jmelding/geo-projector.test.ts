import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import type { JMeldingAnnouncementDiscovered } from "../../src/events/contracts";
import { JMeldingGeoProjector } from "../../src/jmelding/geo-projector";
import { JMeldingGeoRepository } from "../../src/jmelding/geo-repository";

const DATABASE_URL =
  process.env.JMELDING_GEO_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await client`DELETE FROM jmelding_geo WHERE jm_number LIKE 'test-%'`;
  return { db, client };
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[geo-projector.test] skipping — could not connect to test PostGIS DB",
      error instanceof Error ? error.message : error,
    );
    runCtx = null;
  }
});

afterAll(async () => {
  if (runCtx) {
    await runCtx.client`DELETE FROM jmelding_geo WHERE jm_number LIKE 'test-%'`;
    await runCtx.client.end();
  }
});

function makeItem(
  jmNumber: string,
  bodyMarkdown: string,
): JMeldingAnnouncementDiscovered {
  return {
    signature: `sig-${jmNumber}`,
    title: `Test ${jmNumber}`,
    url: `https://www.fiskeridir.no/yrkesfiske/j-meldinger/${jmNumber}`,
    status: "current",
    jmNumber,
    bodyMarkdown,
    checkedAt: new Date().toISOString(),
  };
}

describe("JMeldingGeoProjector + repository", () => {
  test("upserts a geo record idempotently and exposes it via the repository", async () => {
    if (!runCtx) return;
    const projector = new JMeldingGeoProjector(runCtx.db);
    const repository = new JMeldingGeoRepository(runCtx.db);

    const item = makeItem(
      "test-67-2099",
      `Steinryggen:
1. Nord 71 grader 10,000 minutter. Øst 024 grader 53,000 minutter.
2. Nord 71 grader 11,600 minutter. Øst 024 grader 53,700 minutter.`,
    );

    const first = await projector.project(item, "frag-1");
    expect(first.hasGeo).toBe(true);
    expect(first.jmNumber).toBe("test-67-2099");

    const second = await projector.project(item, "frag-1");
    expect(second.hasGeo).toBe(true);

    const fetched = await repository.findByJmNumber("test-67-2099");
    expect(fetched).not.toBeNull();
    expect(fetched?.hasGeo).toBe(true);
    expect(fetched?.fragmentId).toBe("frag-1");
    expect(fetched?.bbox).not.toBeNull();
    expect(Array.isArray(fetched?.bbox)).toBe(true);

    const bbox = fetched?.bbox;
    if (!bbox) throw new Error("bbox missing");
    const [minLon, minLat, maxLon, maxLat] = bbox;
    expect(minLat).toBeCloseTo(71 + 10 / 60, 3);
    expect(maxLat).toBeCloseTo(71 + 11.6 / 60, 3);
    expect(minLon).toBeCloseTo(24 + 53 / 60, 3);
    expect(maxLon).toBeCloseTo(24 + 53.7 / 60, 3);

    const inBbox = await repository.findInBbox({
      minLon: 24,
      minLat: 70,
      maxLon: 32,
      maxLat: 72,
      limit: 10,
    });
    expect(inBbox.rows.some((r) => r.jmNumber === "test-67-2099")).toBe(true);

    const near = await repository.findNear({
      lon: 24 + 53 / 60,
      lat: 71 + 10 / 60,
      radiusKm: 5,
      limit: 10,
    });
    expect(near.rows.some((r) => r.jmNumber === "test-67-2099")).toBe(true);
  });

  test("stores a row without geometry when no coordinates are present", async () => {
    if (!runCtx) return;
    const projector = new JMeldingGeoProjector(runCtx.db);
    const repository = new JMeldingGeoRepository(runCtx.db);

    const item = makeItem(
      "test-69-2099",
      "Det er forbudt for norske fartøy å fiske i britisk sone i ICES´ statistikkområder 4, 2.a, 5.b, 6.a. og 6.b. i 2026.",
    );
    const result = await projector.project(item, null);
    expect(result.hasGeo).toBe(false);

    const fetched = await repository.findByJmNumber("test-69-2099");
    expect(fetched).not.toBeNull();
    expect(fetched?.hasGeo).toBe(false);
    expect(fetched?.bbox).toBeNull();
  });

  test("skips noise rows (no jmNumber + status unknown)", async () => {
    if (!runCtx) return;
    const projector = new JMeldingGeoProjector(runCtx.db);
    const result = await projector.project(
      {
        signature: "sig-noise",
        title: "Noise",
        url: "https://nva.sikt.no/?filter=publisher-abc",
        status: "unknown",
        bodyMarkdown: "",
        checkedAt: new Date().toISOString(),
      },
      null,
    );
    expect(result.skipped).toBe(true);
  });
});
