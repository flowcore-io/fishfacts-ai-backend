import { describe, expect, test } from "bun:test";
import { pendingEventIdOf, recoverSlowProjection } from "../../src/pathways";

/**
 * Reproduce the lib's throw verbatim (@flowcore/pathways
 * `waitForPathwayToBeProcessed`): a plain Error whose message carries the
 * eventId of an event that IS durably written. This test pins the message
 * shape — if upstream rewords it, the recovery stops matching and this
 * fails loudly instead of routes silently 502ing successful writes again.
 */
function libTimeoutError(eventId: string, timeoutMs = 30000): Error {
  return new Error(
    `Pathway processing timed out after ${timeoutMs}ms for event ${eventId}`,
  );
}

describe("pendingEventIdOf", () => {
  test("recovers the eventId from the lib's processing-timeout error", () => {
    expect(
      pendingEventIdOf(libTimeoutError("1478c110-aca7-11f1-ade4-3bd37087b8bc")),
    ).toBe("1478c110-aca7-11f1-ade4-3bd37087b8bc");
    expect(pendingEventIdOf(libTimeoutError("evt-1", 5000))).toBe("evt-1");
  });

  test("anything else is not a pending write", () => {
    expect(pendingEventIdOf(new Error("fetch failed"))).toBeNull();
    expect(
      pendingEventIdOf(new Error("Pathway processing timed out")),
    ).toBeNull();
    expect(
      pendingEventIdOf("Pathway processing timed out after 1ms for event x"),
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
        Promise.reject(libTimeoutError("evt-slow")),
      ),
    ).toBe("evt-slow");
  });

  test("a real write failure still throws", async () => {
    await expect(
      recoverSlowProjection("test", () =>
        Promise.reject(new Error("webhook 503")),
      ),
    ).rejects.toThrow("webhook 503");
  });
});
