import { describe, expect, test } from "bun:test";
import type {
  AisFixWindowRequest,
  AisFixWindowRow,
} from "../../src/ais/clickhouse-repository";
import {
  anchorParamsFromEnv,
  createSildelagetAisAnchorsJob,
  hashAnchorParams,
} from "../../src/jobs/sildelaget-ais-anchors";
import type { SildelagetAisAnchor } from "../../src/sildelaget/ais-anchor";
import type { SildelagetAnchorCandidate } from "../../src/sildelaget/ais-anchor-repository";

const MINUTE = 60_000;

// Minimal env stub: only the anchor knobs are read by this job.
const ENV = {
  AIS_FISHING_MIN_KNOTS: 0.3,
  AIS_FISHING_MAX_KNOTS: 5.5,
  AIS_RUN_MAX_GAP_MINUTES: 30,
  AIS_RUN_MIN_FIXES: 3,
  AIS_RUN_MIN_MINUTES: 15,
  SILDELAGET_AIS_ANCHOR_LOOKBACK_HOURS: 48,
  SILDELAGET_AIS_ANCHOR_SANITY_KM: 150,
  SILDELAGET_JOURNAL_TIME_ZONE: "Europe/Oslo",
  SILDELAGET_AIS_ANCHOR_WINDOW_DAYS: 50,
  SILDELAGET_AIS_ANCHOR_BATCH_REPORTS: 25,
  // biome-ignore lint/suspicious/noExplicitAny: env stub for the job under test.
} as any;

const CONTEXT = {
  signal: new AbortController().signal,
  isStopRequested: () => false,
  reportProgress: () => {},
};

const ARGS = { windowDays: 0, recompute: false, limit: 5000 };

function candidate(
  index: number,
  overrides: Partial<SildelagetAnchorCandidate> = {},
): SildelagetAnchorCandidate {
  return {
    innmeldingId: `report-${index}`,
    reportedDate: "2026-05-28",
    reportedTime: "10:30:00",
    vesselName: `Vessel ${index}`,
    registrationMark: `F-${index}`,
    reportedLatitude: 61,
    reportedLongitude: -6,
    ...overrides,
  };
}

/** A qualifying working stretch ending shortly before the report. */
function fishingFixes(latitude: number, longitude: number): AisFixWindowRow[] {
  const end = Date.parse("2026-05-28T08:00:00.000Z");
  return [0, 8, 16, 24].map((step) => ({
    epochMs: end - (24 - step) * MINUTE,
    latitude,
    longitude,
    speed: 2,
  }));
}

function fakeStore(candidates: SildelagetAnchorCandidate[]) {
  const stored: SildelagetAisAnchor[] = [];
  const listCalls: unknown[] = [];
  return {
    stored,
    listCalls,
    listCandidates: async (options: unknown) => {
      listCalls.push(options);
      return candidates;
    },
    upsertMany: async (anchors: SildelagetAisAnchor[]) => {
      stored.push(...anchors);
      return anchors.length;
    },
  };
}

describe("sildelaget-ais-anchors job", () => {
  test("derives every candidate in one batched pass — no per-report cap", async () => {
    // 60 reports: three times the FE spike's AIS_ANCHOR_MAX_REPORTS = 12, and
    // more than one ClickHouse batch. All 60 must come back derived.
    const candidates = Array.from({ length: 60 }, (_, i) => candidate(i));
    const store = fakeStore(candidates);
    const requestBatches: AisFixWindowRequest[][] = [];

    const run = createSildelagetAisAnchorsJob(ENV, {
      anchors: store,
      vessels: { resolve: async () => 932 },
      fixes: {
        getFixesForWindows: async (requests) => {
          requestBatches.push(requests);
          return new Map(
            requests.map((request) => [request.key, fishingFixes(61.2, -6.2)]),
          );
        },
      },
    });

    const result = await run(undefined, ARGS, CONTEXT);

    expect(store.stored).toHaveLength(60);
    expect(store.stored.every((anchor) => anchor.status === "ok")).toBe(true);
    expect(store.stored.every((anchor) => anchor.runs.length === 1)).toBe(true);
    // 60 reports at 25 per query = 3 ClickHouse round trips, not 60.
    expect(requestBatches).toHaveLength(3);
    expect(requestBatches.map((batch) => batch.length)).toEqual([25, 25, 10]);
    expect(result.changed).toBe(true);
    expect(result.message).toContain("ok=60");
  });

  test("an unresolvable vessel is stored as no-vessel and never queried for", async () => {
    const store = fakeStore([candidate(1), candidate(2)]);
    const requested: AisFixWindowRequest[] = [];
    const run = createSildelagetAisAnchorsJob(ENV, {
      anchors: store,
      vessels: {
        resolve: async (name) => (name === "Vessel 1" ? 932 : null),
      },
      fixes: {
        getFixesForWindows: async (requests) => {
          requested.push(...requests);
          return new Map(
            requests.map((request) => [request.key, fishingFixes(61.2, -6.2)]),
          );
        },
      },
    });

    await run(undefined, ARGS, CONTEXT);

    expect(requested.map((request) => request.key)).toEqual(["report-1"]);
    const byId = new Map(store.stored.map((a) => [a.innmeldingId, a]));
    expect(byId.get("report-1")?.status).toBe("ok");
    expect(byId.get("report-2")?.status).toBe("no-vessel");
    expect(byId.get("report-2")?.vesselId).toBeNull();
  });

  test("the fix window is the report's own 48 h, in the journal's timezone", async () => {
    const store = fakeStore([candidate(1)]);
    const requested: AisFixWindowRequest[] = [];
    const run = createSildelagetAisAnchorsJob(ENV, {
      anchors: store,
      vessels: { resolve: async () => 932 },
      fixes: {
        getFixesForWindows: async (requests) => {
          requested.push(...requests);
          return new Map(requests.map((request) => [request.key, []]));
        },
      },
    });

    await run(undefined, ARGS, CONTEXT);

    // 10:30 Oslo on 2026-05-28 is 08:30Z — not 10:30Z, and not the server's
    // local time either.
    expect(requested[0]?.to).toBe("2026-05-28T08:30:00.000Z");
    expect(requested[0]?.from).toBe("2026-05-26T08:30:00.000Z");
    expect(store.stored[0]?.status).toBe("no-track");
  });

  test("a report with no usable date is skipped, not stored as a guess", async () => {
    const store = fakeStore([candidate(1, { reportedDate: null })]);
    const run = createSildelagetAisAnchorsJob(ENV, {
      anchors: store,
      vessels: { resolve: async () => 932 },
      fixes: { getFixesForWindows: async () => new Map() },
    });

    const result = await run(undefined, ARGS, CONTEXT);

    expect(store.stored).toEqual([]);
    expect(result.message).toContain("no-date=1");
  });

  test("candidates are selected against the current parameter fingerprint", async () => {
    const store = fakeStore([]);
    const run = createSildelagetAisAnchorsJob(ENV, {
      anchors: store,
      vessels: { resolve: async () => null },
      fixes: { getFixesForWindows: async () => new Map() },
    });

    await run(undefined, ARGS, CONTEXT);

    expect(store.listCalls[0]).toMatchObject({
      paramsHash: hashAnchorParams(anchorParamsFromEnv(ENV)),
      recompute: false,
      limit: 5000,
    });
  });

  test("moving the band changes the fingerprint, so old rows are recomputed", () => {
    const params = anchorParamsFromEnv(ENV);
    const before = hashAnchorParams(params);
    // PRD OQ9: the low end is expected to move to 1 kn.
    const after = hashAnchorParams({ ...params, minKnots: 1 });
    expect(after).not.toBe(before);
    // ... and is stable for an unchanged parameter set.
    expect(hashAnchorParams(anchorParamsFromEnv(ENV))).toBe(before);
  });
});
