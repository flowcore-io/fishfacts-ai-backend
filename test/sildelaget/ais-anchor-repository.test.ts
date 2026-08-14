import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import type { SildelagetAisAnchor } from "../../src/sildelaget/ais-anchor";
import { SildelagetAisAnchorRepository } from "../../src/sildelaget/ais-anchor-repository";

const DATABASE_URL =
  process.env.SILDELAGET_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

const PARAMS = { minKnots: 0.3, maxKnots: 5.5 };
const HASH = "hash-a";
/** Retry disabled — the tests that exercise it pass their own values. */
const NO_RETRY = {
  retryStatuses: [] as string[],
  retryAfterHours: 6,
  retryReportedFrom: "2026-05-01",
};

let runCtx: Awaited<ReturnType<typeof connect>> | null = null;

async function connect() {
  const { db, client } = createDb(DATABASE_URL);
  await runMigrations(db, client);
  await wipe(client);
  return { db, client };
}

async function wipe(client: Awaited<ReturnType<typeof connect>>["client"]) {
  await client`DELETE FROM sildelaget_catch_ais_anchors WHERE innmelding_id LIKE 'anchor-test-%'`;
  await client`DELETE FROM sildelaget_catch_lines WHERE innmelding_id LIKE 'anchor-test-%'`;
  await client`DELETE FROM sildelaget_catch_entries WHERE innmelding_id LIKE 'anchor-test-%'`;
}

beforeAll(async () => {
  try {
    runCtx = await connect();
  } catch (error) {
    console.warn(
      "[sildelaget-ais-anchor-repository.test] skipping — could not connect to test DB",
      error instanceof Error ? error.message : error,
    );
    runCtx = null;
  }
});

afterAll(async () => {
  if (!runCtx) return;
  await wipe(runCtx.client);
  await runCtx.client.end();
});

function anchor(
  innmeldingId: string,
  overrides: Partial<SildelagetAisAnchor> = {},
): SildelagetAisAnchor {
  return {
    innmeldingId,
    status: "ok",
    vesselId: 932,
    reportedAt: "2026-05-28T08:30:00.000Z",
    reportedLatitude: 60.5,
    reportedLongitude: 2.5,
    windowFrom: "2026-05-26T08:30:00.000Z",
    windowTo: "2026-05-28T08:30:00.000Z",
    fixCount: 1842,
    runs: [
      {
        latitude: 61.0123,
        longitude: 2.1187,
        fixCount: 26,
        runStart: "2026-05-27T22:05:00.000Z",
        runEnd: "2026-05-27T23:10:00.000Z",
        avgKnots: 2.4,
        distanceFromReportedKm: 66.6,
        beyondSanityLimit: false,
      },
    ],
    ...overrides,
  };
}

async function seedEntry(
  client: Awaited<ReturnType<typeof connect>>["client"],
  innmeldingId: string,
  options: { latitude?: number; longitude?: number } = {},
) {
  await client`
    INSERT INTO sildelaget_catch_entries (
      innmelding_id, reported_date, reported_time, vessel_name,
      registration_mark, entry_hash, source_url, raw_entry,
      source_event_id, checked_at
    ) VALUES (
      ${innmeldingId}, '2026-05-28', '10:30:00', 'Fiskebas',
      'FO-123', 'hash', 'https://example.test/x.xlsx', '{}'::jsonb,
      'evt-1', now()
    )
    ON CONFLICT (innmelding_id) DO UPDATE SET updated_at = now()
  `;
  // Two lines; only the LAST one carries a coordinate, so the candidate query
  // has to pick that one rather than the first.
  await client`DELETE FROM sildelaget_catch_lines WHERE innmelding_id = ${innmeldingId}`;
  await client`
    INSERT INTO sildelaget_catch_lines (
      line_key, innmelding_id, line_index, species, raw_row, source_event_id
    ) VALUES (${`${innmeldingId}-l0`}, ${innmeldingId}, 0, 'NVG-sild', '{}'::jsonb, 'evt-1')
  `;
  await client`
    INSERT INTO sildelaget_catch_lines (
      line_key, innmelding_id, line_index, species,
      route_center_latitude, route_center_longitude, raw_row, source_event_id
    ) VALUES (
      ${`${innmeldingId}-l1`}, ${innmeldingId}, 1, 'NVG-sild',
      ${options.latitude ?? 60.5}, ${options.longitude ?? 2.5}, '{}'::jsonb, 'evt-1'
    )
  `;
}

describe("SildelagetAisAnchorRepository", () => {
  test("runs survive the jsonb round trip as an array, not a JSON string", async () => {
    if (!runCtx) return;
    const repository = new SildelagetAisAnchorRepository(runCtx.db);
    await repository.upsertMany([anchor("anchor-test-1")], PARAMS, HASH);

    const byId = await repository.loadByInnmeldingIds(["anchor-test-1"]);
    const stored = byId.get("anchor-test-1");
    expect(Array.isArray(stored?.runs)).toBe(true);
    expect(stored?.runs).toHaveLength(1);
    expect(stored?.runs[0]).toMatchObject({
      latitude: 61.0123,
      longitude: 2.1187,
      fixCount: 26,
      avgKnots: 2.4,
      distanceFromReportedKm: 66.6,
      beyondSanityLimit: false,
    });
    expect(stored?.status).toBe("ok");
    expect(stored?.vesselId).toBe(932);
    expect(stored?.reportedAt).toBe("2026-05-28T08:30:00.000Z");
    expect(stored?.fixCount).toBe(1842);
  });

  test("re-deriving a report replaces its anchor instead of duplicating it", async () => {
    if (!runCtx) return;
    const repository = new SildelagetAisAnchorRepository(runCtx.db);
    await repository.upsertMany([anchor("anchor-test-2")], PARAMS, HASH);
    await repository.upsertMany(
      [anchor("anchor-test-2", { status: "no-run", runs: [] })],
      PARAMS,
      HASH,
    );

    const byId = await repository.loadByInnmeldingIds(["anchor-test-2"]);
    expect(byId.size).toBe(1);
    expect(byId.get("anchor-test-2")?.status).toBe("no-run");
    expect(byId.get("anchor-test-2")?.runs).toEqual([]);
  });

  test("candidates carry the report's LAST coordinate-bearing line", async () => {
    if (!runCtx) return;
    await seedEntry(runCtx.client, "anchor-test-3", {
      latitude: 61.25,
      longitude: 2.75,
    });
    const repository = new SildelagetAisAnchorRepository(runCtx.db);

    const candidates = await repository.listCandidates({
      from: "2026-05-01",
      to: "2026-06-30",
      paramsHash: HASH,
      recompute: false,
      limit: 100,
      ...NO_RETRY,
    });
    const candidate = candidates.find(
      (row) => row.innmeldingId === "anchor-test-3",
    );
    expect(candidate).toMatchObject({
      reportedDate: "2026-05-28",
      reportedTime: "10:30:00",
      vesselName: "Fiskebas",
      registrationMark: "FO-123",
      reportedLatitude: 61.25,
      reportedLongitude: 2.75,
    });
  });

  test("a derived report drops out of the candidate list until something changes", async () => {
    if (!runCtx) return;
    await seedEntry(runCtx.client, "anchor-test-4");
    const repository = new SildelagetAisAnchorRepository(runCtx.db);
    const ids = async (options?: {
      paramsHash?: string;
      recompute?: boolean;
    }) =>
      (
        await repository.listCandidates({
          from: "2026-05-01",
          to: "2026-06-30",
          paramsHash: options?.paramsHash ?? HASH,
          recompute: options?.recompute ?? false,
          limit: 100,
          ...NO_RETRY,
        })
      ).map((row) => row.innmeldingId);

    expect(await ids()).toContain("anchor-test-4");
    await repository.upsertMany([anchor("anchor-test-4")], PARAMS, HASH);
    expect(await ids()).not.toContain("anchor-test-4");

    // The band moves (PRD OQ9) ⇒ a new fingerprint ⇒ the row is due again.
    expect(await ids({ paramsHash: "hash-b" })).toContain("anchor-test-4");
    // ...as it is on an explicit recompute.
    expect(await ids({ recompute: true })).toContain("anchor-test-4");

    // And when the report itself is re-projected, its anchor is stale.
    await seedEntry(runCtx.client, "anchor-test-4");
    expect(await ids()).toContain("anchor-test-4");
  });

  test("a non-ok answer is re-listed once it is old enough — it is provisional", async () => {
    if (!runCtx) return;
    await seedEntry(runCtx.client, "anchor-test-6");
    const repository = new SildelagetAisAnchorRepository(runCtx.db);
    const ids = async (retry: {
      statuses: string[];
      afterHours: number;
      from?: string;
    }) =>
      (
        await repository.listCandidates({
          from: "2026-05-01",
          to: "2026-06-30",
          paramsHash: HASH,
          recompute: false,
          limit: 100,
          retryStatuses: retry.statuses,
          retryAfterHours: retry.afterHours,
          retryReportedFrom: retry.from ?? "2026-05-01",
        })
      ).map((row) => row.innmeldingId);

    // The registry was down for this report, or AIS had not caught up yet.
    await repository.upsertMany(
      [anchor("anchor-test-6", { status: "no-track", runs: [] })],
      PARAMS,
      HASH,
    );

    const retryStatuses = ["no-vessel", "no-track", "no-run"];
    // Just derived: left alone.
    expect(await ids({ statuses: retryStatuses, afterHours: 6 })).not.toContain(
      "anchor-test-6",
    );
    // Old enough (0 h): asked again.
    expect(await ids({ statuses: retryStatuses, afterHours: 0 })).toContain(
      "anchor-test-6",
    );
    // ...but only while the REPORT is young enough, so the retry ends.
    expect(
      await ids({
        statuses: retryStatuses,
        afterHours: 0,
        from: "2026-06-01",
      }),
    ).not.toContain("anchor-test-6");

    // A settled "ok" is not in the retry set at all.
    await repository.upsertMany([anchor("anchor-test-6")], PARAMS, HASH);
    expect(await ids({ statuses: retryStatuses, afterHours: 0 })).not.toContain(
      "anchor-test-6",
    );
  });

  test("a report whose date cannot be parsed is never a candidate", async () => {
    if (!runCtx) return;
    // Sildelaget hands dates through as text. These two are BETWEEN the range
    // bounds as strings — the date filter cannot be what excludes them — but
    // reportEpochMs cannot read either, so they have no window. Listing them
    // would burn a registry lookup and a skip on every hourly run, forever.
    await seedEntry(runCtx.client, "anchor-test-7");
    await runCtx.client`
      UPDATE sildelaget_catch_entries SET reported_date = '2026-05-2'
      WHERE innmelding_id = 'anchor-test-7'
    `;
    await seedEntry(runCtx.client, "anchor-test-8");
    await runCtx.client`
      UPDATE sildelaget_catch_entries SET reported_date = '2026-05-28x'
      WHERE innmelding_id = 'anchor-test-8'
    `;
    const repository = new SildelagetAisAnchorRepository(runCtx.db);

    const listed = async (from: string, to: string) =>
      (
        await repository.listCandidates({
          from,
          to,
          paramsHash: HASH,
          recompute: true,
          limit: 500,
          ...NO_RETRY,
        })
      ).map((row) => row.innmeldingId);

    // Both sit inside this range lexically...
    expect("2026-05-2" > "2026-01-01" && "2026-05-2" < "2026-12-31").toBe(true);
    expect("2026-05-28x" > "2026-01-01" && "2026-05-28x" < "2026-12-31").toBe(
      true,
    );
    // ...and neither is offered for derivation.
    const ids = await listed("2026-01-01", "2026-12-31");
    expect(ids).not.toContain("anchor-test-7");
    expect(ids).not.toContain("anchor-test-8");
  });

  test("loadForDateRange returns anchors for the reports in range", async () => {
    if (!runCtx) return;
    await seedEntry(runCtx.client, "anchor-test-5");
    const repository = new SildelagetAisAnchorRepository(runCtx.db);
    await repository.upsertMany([anchor("anchor-test-5")], PARAMS, HASH);

    const inRange = await repository.loadForDateRange({
      from: "2026-05-01",
      to: "2026-06-30",
    });
    expect(inRange.some((row) => row.innmeldingId === "anchor-test-5")).toBe(
      true,
    );

    const outOfRange = await repository.loadForDateRange({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(outOfRange.some((row) => row.innmeldingId === "anchor-test-5")).toBe(
      false,
    );
  });
});
