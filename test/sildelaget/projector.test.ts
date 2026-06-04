import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import type { SildelagetCatchEntryObserved } from "../../src/events/contracts";
import { SildelagetCatchProjector } from "../../src/sildelaget/projector";
import { SildelagetCatchRepository } from "../../src/sildelaget/repository";

const DATABASE_URL =
  process.env.SILDELAGET_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await client`DELETE FROM sildelaget_catch_lines WHERE innmelding_id LIKE 'test-sild-%'`;
  await client`DELETE FROM sildelaget_catch_entries WHERE innmelding_id LIKE 'test-sild-%'`;
  return { db, client };
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[sildelaget-projector.test] skipping — could not connect to test DB",
      error instanceof Error ? error.message : error,
    );
    runCtx = null;
  }
});

afterAll(async () => {
  if (!runCtx) return;
  await runCtx.client`DELETE FROM sildelaget_catch_lines WHERE innmelding_id LIKE 'test-sild-%'`;
  await runCtx.client`DELETE FROM sildelaget_catch_entries WHERE innmelding_id LIKE 'test-sild-%'`;
  await runCtx.client.end();
});

describe("SildelagetCatchProjector + repository", () => {
  test("observed event inserts entry and lines idempotently", async () => {
    if (!runCtx) return;
    const repository = new SildelagetCatchRepository(runCtx.db);
    const projector = new SildelagetCatchProjector(repository);
    const entry = makeEntry("test-sild-1001", "v1", ["NVG-sild", "Makrell"]);

    await projector.handleObserved({ eventId: "evt-sild-1", payload: entry });
    await projector.handleObserved({ eventId: "evt-sild-2", payload: entry });

    const page = await repository.listFull({
      from: "2026-01-01",
      to: "2026-12-31",
      innmeldingId: "test-sild-1001",
      limit: 10,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].sourceEventId).toBe("evt-sild-1");
    expect(page.rows[0].lines).toHaveLength(2);
    expect(page.rows[0].lines.map((line) => line.species).sort()).toEqual([
      "Makrell",
      "NVG-sild",
    ]);
    expect(page.rows[0].lines[0]).toMatchObject({
      routeKey: "#0005",
      routeFaoArea: "27.4.A",
      routeCenterLatitude: 60.5,
      routeCenterLongitude: 2.5,
    });
  });

  test("changed hash replaces all child lines", async () => {
    if (!runCtx) return;
    const repository = new SildelagetCatchRepository(runCtx.db);
    const projector = new SildelagetCatchProjector(repository);

    await projector.handleObserved({
      eventId: "evt-sild-3",
      payload: makeEntry("test-sild-1002", "v1", ["NVG-sild", "Makrell"]),
    });
    await projector.handleObserved({
      eventId: "evt-sild-4",
      payload: makeEntry("test-sild-1002", "v2", ["Kolmule"]),
    });

    const page = await repository.listFull({
      from: "2026-01-01",
      to: "2026-12-31",
      innmeldingId: "test-sild-1002",
      limit: 10,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].entryHash).toBe(hash("entry-test-sild-1002-v2"));
    expect(page.rows[0].sourceEventId).toBe("evt-sild-4");
    expect(page.rows[0].lines).toHaveLength(1);
    expect(page.rows[0].lines[0].species).toBe("Kolmule");
  });
});

function makeEntry(
  innmeldingId: string,
  version: string,
  species: string[],
): SildelagetCatchEntryObserved {
  return {
    innmeldingId,
    reportedDate: "2026-05-28",
    reportedTime: "10:30:00",
    vesselName: "Fiskebas",
    registrationMark: "FO-123",
    entryHash: hash(`entry-${innmeldingId}-${version}`),
    sourceUrl: "https://example.test/export.xlsx",
    checkedAt: "2026-05-28T10:35:00.000Z",
    rawEntry: { version },
    lines: species.map((name, index) => ({
      lineKey: hash(`line-${innmeldingId}-${version}-${name}`),
      lineIndex: index,
      fishingStartDate: "2026-05-27",
      fishingStartTime: "22:00:00",
      species: name,
      tonnes: index + 1,
      weightKg: (index + 1) * 1000,
      average: 325,
      catchType: "Direkte",
      salesType: "Auksjon",
      gear: "Not",
      route: "5",
      routeKey: "#0005",
      routeFaoArea: "27.4.A",
      routeCenterLatitude: 60.5,
      routeCenterLongitude: 2.5,
      routeCoordinates: [
        { latitude: 60, longitude: 2 },
        { latitude: 61, longitude: 2 },
        { latitude: 61, longitude: 3 },
        { latitude: 60, longitude: 3 },
        { latitude: 60, longitude: 2 },
      ],
      use: "Konsum",
      pct1: 10,
      pct2: 20,
      pct3: 30,
      pct4: 40,
      assortment: "Sortiment",
      offerEastSouth: "Ja",
      offerEastSouthDate: "2026-05-29",
      offerEastSouthTime: "12:00:00",
      offerEastNorth: null,
      offerEastNorthDate: null,
      offerEastNorthTime: null,
      offerWestSouth: null,
      offerWestSouthDate: null,
      offerWestSouthTime: null,
      offerWestNorth: null,
      offerWestNorthDate: null,
      offerWestNorthTime: null,
      leasedVessel: null,
      economicZone: "NO",
      municipality: "Torshavn",
      coFisher: null,
      buyer: "Buyer AS",
      receiver: "Receiver AS",
      nationality: "NO",
      rawRow: { name, version },
    })),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
