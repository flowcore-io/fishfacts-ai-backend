import { describe, expect, test } from "bun:test";
import { pendingEventIdOf, recoverSlowProjection } from "../../src/pathways";

const EVENT_ID = "1478c110-aca7-11f1-ade4-3bd37087b8bc";

/**
 * The lib's throw, verbatim per version (@flowcore/pathways
 * `waitForPathwayToBeProcessed`): a plain Error whose message carries the
 * eventId of an event that IS durably written. BOTH known wordings are
 * pinned — 2.7.0, inside our ^-range, appended prose after the id, which is
 * exactly the reword an end-anchored pattern would have silently missed
 * (review finding on #184). A future wording that matches neither fails
 * these tests loudly instead of reverting routes to 502-on-success.
 */
function v246TimeoutError(eventId: string, timeoutMs = 30000): Error {
  return new Error(
    `Pathway processing timed out after ${timeoutMs}ms for event ${eventId}`,
  );
}

function v270TimeoutError(eventId: string, timeoutMs = 30000): Error {
  return new Error(
    `Pathway processing timed out after ${timeoutMs}ms for event ${eventId}. The event was written successfully and is durable; it will still be processed. Do not retry.`,
  );
}

describe("pendingEventIdOf", () => {
  test("recovers the eventId from the 2.4.6 wording", () => {
    expect(pendingEventIdOf(v246TimeoutError(EVENT_ID))).toBe(EVENT_ID);
    expect(pendingEventIdOf(v246TimeoutError(EVENT_ID, 5000))).toBe(EVENT_ID);
  });

  test("recovers the eventId from the 2.7.0 wording — trailing prose, no trailing-period capture", () => {
    expect(pendingEventIdOf(v270TimeoutError(EVENT_ID))).toBe(EVENT_ID);
  });

  test("anything else is not a pending write", () => {
    expect(pendingEventIdOf(new Error("fetch failed"))).toBeNull();
    expect(
      pendingEventIdOf(new Error("Pathway processing timed out")),
    ).toBeNull();
    // A message-shaped string is not an Error.
    expect(
      pendingEventIdOf(
        `Pathway processing timed out after 1ms for event ${EVENT_ID}`,
      ),
    ).toBeNull();
    // The capture is anchored to the id's UUID shape — a non-id token in the
    // id position must not be "recovered" as one.
    expect(
      pendingEventIdOf(
        new Error("Pathway processing timed out after 1ms for event unknown"),
      ),
    ).toBeNull();
    expect(pendingEventIdOf(null)).toBeNull();
  });
});

describe("recoverSlowProjection", () => {
  test("passes a successful write through untouched", async () => {
    expect(
      await recoverSlowProjection("test", () => Promise.resolve("evt-ok")),
    ).toBe("evt-ok");
  });

  test("a processing timeout returns the pending eventId instead of throwing", async () => {
    expect(
      await recoverSlowProjection("test", () =>
        Promise.reject(v246TimeoutError(EVENT_ID)),
      ),
    ).toBe(EVENT_ID);
    expect(
      await recoverSlowProjection("test", () =>
        Promise.reject(v270TimeoutError(EVENT_ID)),
      ),
    ).toBe(EVENT_ID);
  });

  test("a real write failure still throws", async () => {
    await expect(
      recoverSlowProjection("test", () =>
        Promise.reject(new Error("webhook 503")),
      ),
    ).rejects.toThrow("webhook 503");
  });
});
