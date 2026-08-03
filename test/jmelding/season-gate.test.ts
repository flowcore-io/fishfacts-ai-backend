import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import type { JMeldingAnnouncementDiscovered } from "../../src/events/contracts";
import { JMeldingGeoProjector } from "../../src/jmelding/geo-projector";
import { JMeldingGeoRepository } from "../../src/jmelding/geo-repository";

const DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

type Ctx = ReturnType<typeof createDb>;
let ctx: Ctx | null = null;
let projector: JMeldingGeoProjector;
let repository: JMeldingGeoRepository;

const IN_SEASON = new Date("2026-03-15T12:00:00.000Z");
const OUT_OF_SEASON = new Date("2026-08-03T12:00:00.000Z");

/** A ring around the Faroes, big enough to be found by any sane bbox. */
const RING = [
  { lat: 61.0, lon: -8.0 },
  { lat: 61.5, lon: -8.0 },
  { lat: 61.5, lon: -7.0 },
  { lat: 61.0, lon: -7.0 },
];

function item(
  over: Partial<JMeldingAnnouncementDiscovered>,
): JMeldingAnnouncementDiscovered {
  return {
    signature: `sig-${over.jmNumber}`,
    title: String(over.jmNumber),
    url: `https://example.test/${over.jmNumber}`,
    status: "current",
    region: "FO",
    bodyMarkdown: "",
    checkedAt: "2026-08-03T00:00:00.000Z",
    areas: [{ name: "A", points: RING }],
    ...over,
  } as JMeldingAnnouncementDiscovered;
}

const cleanup = async () => {
  if (!ctx) return;
  await ctx.client`DELETE FROM jmelding_geo WHERE jm_number LIKE 'season-%'`;
};

describe("season gate on listForDrawing", () => {
  beforeAll(async () => {
    try {
      const created = createDb(DATABASE_URL);
      await runMigrations(created.db, created.client);
      ctx = created;
      projector = new JMeldingGeoProjector(created.db);
      repository = new JMeldingGeoRepository(created.db);
      await created.client`DELETE FROM jmelding_geo WHERE jm_number LIKE 'season-%'`;

      // Seasonal: 1 Feb – 1 May, exactly K 45/2022's window.
      await projector.project(
        item({
          jmNumber: "season-seasonal",
          recurrence: { type: "annual", from: "02-01", to: "05-01" },
        }),
        "frag-1",
      );
      // Lógasavn, but year-round — no recurrence recorded.
      await projector.project(item({ jmNumber: "season-yearround" }), "frag-2");
      // A Vørn emergency ban: region FO too, and must never be gated.
      await projector.project(
        item({ jmNumber: "season-vorn", category: "bráðfeingis veiðibann" }),
        null,
      );
    } catch (error) {
      console.warn(
        "[season-gate.test] skipping — could not connect to test PostGIS DB",
        error instanceof Error ? error.message : error,
      );
      ctx = null;
    }
  });

  afterAll(async () => {
    if (ctx) {
      await cleanup();
      await ctx.client.end();
    }
  });

  const drawn = async (asOf: Date) =>
    (await repository.listForDrawing({ region: "FO", asOf }))
      .map((r) => r.jmNumber)
      .filter((n) => n.startsWith("season-"));

  test("a seasonal closure is drawn inside its window", async () => {
    if (!ctx) return;

    expect(await drawn(IN_SEASON)).toContain("season-seasonal");
  });

  // The finding that made this whole slice a precondition rather than polish:
  // approving K 45/2022 in August would otherwise have drawn a closure over
  // water that is legally open.
  test("a seasonal closure is NOT drawn outside its window", async () => {
    if (!ctx) return;

    expect(await drawn(OUT_OF_SEASON)).not.toContain("season-seasonal");
  });

  test("a year-round Lógasavn closure is drawn in both", async () => {
    if (!ctx) return;

    expect(await drawn(IN_SEASON)).toContain("season-yearround");
    expect(await drawn(OUT_OF_SEASON)).toContain("season-yearround");
  });

  // The gate must narrow ONLY rows a human marked seasonal. Vørn's bans are
  // region FO as well, and dropping one would take a live closure off the map.
  test("a Vørn ban in the same region is never gated", async () => {
    if (!ctx) return;

    expect(await drawn(IN_SEASON)).toContain("season-vorn");
    expect(await drawn(OUT_OF_SEASON)).toContain("season-vorn");
  });

  test("the stored window comes back with the row", async () => {
    if (!ctx) return;
    const rows = await repository.listForDrawing({
      region: "FO",
      asOf: IN_SEASON,
    });

    // So the agent can narrate "closed now, opens again 1 May" rather than
    // guessing — the point of returning temporal fields alongside geometry.
    const seasonal = rows.find((r) => r.jmNumber === "season-seasonal");
    expect(seasonal?.recurrence).toEqual({
      type: "annual",
      from: "02-01",
      to: "05-01",
    });
  });

  test("asOf defaults to now rather than changing behaviour", async () => {
    if (!ctx) return;
    const withDefault = (await repository.listForDrawing({ region: "FO" }))
      .map((r) => r.jmNumber)
      .filter((n) => n.startsWith("season-"));

    expect(withDefault).toEqual(await drawn(new Date()));
  });
});
