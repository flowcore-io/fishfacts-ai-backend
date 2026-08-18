import { describe, expect, test } from "bun:test";
import {
  CATCH_PAGE_LIMIT_DEFAULT,
  CATCH_PAGE_LIMIT_MAX,
  type FullCatchFilters,
  type SildelagetCatchRepository,
} from "../../src/sildelaget/repository";
import { createSildelagetCatchRouter } from "../../src/sildelaget/routes";

/**
 * What `/api/catch/full` hands the repository — the query parsing only, with
 * no database behind it.
 *
 * The page limit is here because a client cannot see it: the route clamps and
 * answers a short page as if that were all there was. The FishFacts map asked
 * for a 50-day window in one 500-row page, got the 200 the old cap allowed,
 * and showed 33 of the 49 days that had catches with nothing to say the rest
 * existed (Gilli N. Lorenzen, 2026-08-18).
 */
function routerWithSpy() {
  const asked: FullCatchFilters[] = [];
  const repository = {
    aggregateFishfactsCatches: async () => ({}),
    listFull: async (filters: FullCatchFilters) => {
      asked.push(filters);
      return { rows: [], nextCursor: null };
    },
  } as unknown as SildelagetCatchRepository;
  return { app: createSildelagetCatchRouter({ repository }), asked };
}

const RANGE = "from=2026-06-29&to=2026-08-18";

describe("GET /full — page limit", () => {
  test("passes a 500-row ask straight through", async () => {
    const { app, asked } = routerWithSpy();

    const response = await app.request(`/full?${RANGE}&limit=500`);

    expect(response.status).toBe(200);
    expect(asked[0]?.limit).toBe(CATCH_PAGE_LIMIT_MAX);
  });

  test("clamps an ask past the maximum to it", async () => {
    const { app, asked } = routerWithSpy();

    await app.request(`/full?${RANGE}&limit=9999`);

    expect(asked[0]?.limit).toBe(CATCH_PAGE_LIMIT_MAX);
  });

  test("falls back to the default when no limit is asked for", async () => {
    const { app, asked } = routerWithSpy();

    await app.request(`/full?${RANGE}`);

    expect(asked[0]?.limit).toBe(CATCH_PAGE_LIMIT_DEFAULT);
  });

  test("keeps the cursor a client pages on", async () => {
    const { app, asked } = routerWithSpy();

    await app.request(`/full?${RANGE}&limit=500&cursor=opaque-cursor`);

    expect(asked[0]?.cursor).toBe("opaque-cursor");
  });
});
