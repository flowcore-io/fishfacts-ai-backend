import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import type { ObservedCandidate } from "../../src/logasavn/review";
import { mergeReviewRows } from "../../src/logasavn/review";
import { LogasavnReviewRepository } from "../../src/logasavn/review-repository";
import { createLogasavnReviewRouter } from "../../src/logasavn/routes";

/**
 * Hardcoded, and deliberately NOT read from `process.env.DATABASE_URL`.
 *
 * Bun auto-loads `.env`, and a developer's `.env` in this repo may point at the
 * PRODUCTION database — that is how maintenance scripts are run against it. A
 * test that honoured the environment would therefore seed fixture rows into,
 * and delete rows from, the live review queue the moment someone ran `bun test`
 * in a worktree that had one. CI sets no `DATABASE_URL` for the test step, so
 * this is also exactly what CI uses.
 */
const DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/fishfacts_ai_backend_test";

/** Second belt: never touch a database that is not a *_test one. */
function assertTestDatabase(url: string) {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`refusing to run against non-test database "${name}"`);
  }
}

const IN_FORCE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SUPERSEDED_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const GAP_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const TEST_IDS = [IN_FORCE_ID, SUPERSEDED_ID, GAP_ID];
const SWEPT_AT = "2026-08-03T05:00:00.000Z";

/** Stands in for the real token middleware; the router's own requireAdmin runs. */
const fakeAuth =
  (username: string, authorities: string[]): MiddlewareHandler =>
  async (c, next) => {
    c.set("auth", { user: { username, authorities } } as never);
    return next();
  };

function candidate(over: Partial<ObservedCandidate> = {}): ObservedCandidate {
  return {
    fragmentId: IN_FORCE_ID,
    contentHash: "a".repeat(64),
    title: "Kunngerð nr. 35 (2026) — Føroyabanki",
    authority: "uttanrikis-og-fiskimalaradid",
    validityStatus: "Galdandi",
    coordinateLike: 20,
    ringCount: 1,
    vertexCount: 10,
    withheldCount: 0,
    detectors: [{ detectorId: "coordinate-text", candidate: true, signal: 20 }],
    ...over,
  };
}

let sql: ReturnType<typeof postgres>;
let repository: LogasavnReviewRepository;
let admin: Hono;
let run = false;

const cleanup = async () => {
  await sql`DELETE FROM logasavn_review WHERE fragment_id = ANY(${TEST_IDS})`;
};

/** Seed the queue exactly as a sweep would, so the rows are real ones. */
const seed = async (observed: ObservedCandidate[]) => {
  await cleanup();
  await repository.apply(
    mergeReviewRows(
      [],
      {
        scannedFragmentIds: new Set(observed.map((o) => o.fragmentId)),
        observed,
      },
      SWEPT_AT,
    ),
  );
};

const mount = (auth: MiddlewareHandler) => {
  const app = new Hono();
  app.route(
    "/api/logasavn/review",
    createLogasavnReviewRouter({ repository, authMiddleware: auth }),
  );
  return app;
};

describe("Lógasavn review routes black-box", () => {
  beforeAll(async () => {
    try {
      assertTestDatabase(DATABASE_URL);
      sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
      await sql`SELECT 1 FROM logasavn_review LIMIT 1`;
      repository = new LogasavnReviewRepository(
        drizzle(sql, { schema }) as never,
      );
      admin = mount(fakeAuth("gilli", ["ADMIN"]));
      await cleanup();
      run = true;
    } catch (error) {
      console.warn(
        "[logasavn-review-routes.blackbox.test] skipping — could not connect to test DB",
        error instanceof Error ? error.message : error,
      );
      run = false;
    }
  });

  afterAll(async () => {
    if (run) await cleanup();
    await sql?.end();
  });

  test("lists pending rows in force first, with a queue summary", async () => {
    if (!run) return;
    await seed([
      candidate({
        fragmentId: SUPERSEDED_ID,
        contentHash: "b".repeat(64),
        title: "A superseded statute",
        validityStatus: "Áður galdandi",
      }),
      candidate(),
    ]);

    const resp = await admin.request("/api/logasavn/review");
    const body = (await resp.json()) as {
      rows: { fragmentId: string; reviewStatus: string }[];
      summary: { inForcePending: number; byStatus: Record<string, number> };
    };

    expect(resp.status).toBe(200);
    // In force first, regardless of insertion order.
    expect(body.rows[0]?.fragmentId).toBe(IN_FORCE_ID);
    expect(body.summary.inForcePending).toBeGreaterThanOrEqual(1);
    expect(body.summary.byStatus.pending).toBeGreaterThanOrEqual(2);
  });

  test("filters to in-force candidates only", async () => {
    if (!run) return;
    await seed([
      candidate(),
      candidate({
        fragmentId: SUPERSEDED_ID,
        contentHash: "b".repeat(64),
        validityStatus: "Áður galdandi",
      }),
    ]);

    const resp = await admin.request("/api/logasavn/review?inForce=true");
    const body = (await resp.json()) as { rows: { fragmentId: string }[] };

    expect(body.rows.map((r) => r.fragmentId)).not.toContain(SUPERSEDED_ID);
    expect(body.rows.map((r) => r.fragmentId)).toContain(IN_FORCE_ID);
  });

  test("filters by review reason", async () => {
    if (!run) return;
    await seed([
      candidate(),
      candidate({
        fragmentId: GAP_ID,
        contentHash: "c".repeat(64),
        ringCount: 0,
        vertexCount: 0,
        coordinateLike: 106,
      }),
    ]);

    const resp = await admin.request(
      "/api/logasavn/review?reason=unreadable_geometry",
    );
    const body = (await resp.json()) as { rows: { fragmentId: string }[] };

    expect(body.rows.map((r) => r.fragmentId)).toEqual([GAP_ID]);
  });

  test("records an approval and stamps the reviewer from the token", async () => {
    if (!run) return;
    await seed([candidate()]);

    const resp = await admin.request(
      `/api/logasavn/review/${IN_FORCE_ID}/${"a".repeat(64)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // The body TRIES to claim someone else made this decision.
        body: JSON.stringify({
          status: "approved",
          recurrence: { type: "annual", from: "02-01", to: "05-01" },
          reviewedBy: "someone-else",
        }),
      },
    );
    const body = (await resp.json()) as {
      row: { reviewStatus: string; reviewedBy: string; recurrence: unknown };
    };

    expect(resp.status).toBe(200);
    expect(body.row.reviewStatus).toBe("approved");
    // Attribution comes from the authenticated admin, never the payload.
    expect(body.row.reviewedBy).toBe("gilli");
    expect(body.row.recurrence).toEqual({
      type: "annual",
      from: "02-01",
      to: "05-01",
    });
  });

  test("rejects a decline with no reason", async () => {
    if (!run) return;
    await seed([candidate()]);

    const resp = await admin.request(
      `/api/logasavn/review/${IN_FORCE_ID}/${"a".repeat(64)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "declined" }),
      },
    );

    expect(resp.status).toBe(400);
    const after = await repository.listForReview({ status: "pending" });
    expect(after.map((r) => r.fragmentId)).toContain(IN_FORCE_ID);
  });

  // THE property of this router: an approval is an approval OF SPECIFIC TEXT.
  // If the sweep re-scraped between the reviewer reading the row and deciding
  // on it, the write must be refused rather than applied to text never seen.
  test("refuses a verdict against a hash the source has moved past", async () => {
    if (!run) return;
    await seed([candidate()]);
    // A sweep observes new text for the same statute.
    await repository.apply(
      mergeReviewRows(
        await repository.loadAll(),
        {
          scannedFragmentIds: new Set([IN_FORCE_ID]),
          observed: [candidate({ contentHash: "d".repeat(64) })],
        },
        "2026-08-04T05:00:00.000Z",
      ),
    );

    const resp = await admin.request(
      `/api/logasavn/review/${IN_FORCE_ID}/${"a".repeat(64)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
    );
    const body = (await resp.json()) as {
      error: string;
      currentHash: string;
    };

    expect(resp.status).toBe(409);
    expect(body.error).toBe("stale_content_hash");
    // Hand back the current hash so the reviewer can re-read and decide again.
    expect(body.currentHash).toBe("d".repeat(64));

    const rows = await repository.loadAll();
    const stale = rows.find((r) => r.contentHash === "a".repeat(64));
    const current = rows.find((r) => r.contentHash === "d".repeat(64));
    expect(stale?.reviewStatus).toBe("pending");
    expect(current?.reviewStatus).toBe("pending");
  });

  test("404s for a fragment that is not in the queue", async () => {
    if (!run) return;
    await cleanup();

    const resp = await admin.request(
      `/api/logasavn/review/${IN_FORCE_ID}/${"a".repeat(64)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
    );

    expect(resp.status).toBe(404);
  });

  test("a non-admin can neither read the queue nor decide", async () => {
    if (!run) return;
    await seed([candidate()]);
    const user = mount(fakeAuth("skipper", ["USER"]));

    const list = await user.request("/api/logasavn/review");
    const patch = await user.request(
      `/api/logasavn/review/${IN_FORCE_ID}/${"a".repeat(64)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
    );

    expect(list.status).toBe(403);
    expect(patch.status).toBe(403);
    const after = await repository.listForReview({ status: "pending" });
    expect(after.map((r) => r.fragmentId)).toContain(IN_FORCE_ID);
  });
});
