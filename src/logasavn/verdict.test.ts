import { describe, expect, test } from "bun:test";
import { recurrenceSchema, verdictInputSchema } from "./verdict";

const parse = (input: unknown) => verdictInputSchema.safeParse(input);
const issuePaths = (result: ReturnType<typeof parse>) =>
  result.success ? [] : result.error.issues.map((i) => i.path.join("."));

describe("verdictInputSchema", () => {
  test("an approval needs nothing but the status", () => {
    const result = parse({ status: "approved" });

    expect(result.success).toBe(true);
  });

  // The treaty documents are the reason declines are recorded at all: they are
  // a DECISION not to draw, and six months on an unexplained "declined" is
  // indistinguishable from an oversight.
  test("a decline without a reason is rejected", () => {
    const result = parse({ status: "declined" });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("declineReason");
  });

  test("a decline with a reason is accepted", () => {
    const result = parse({
      status: "declined",
      declineReason: "treaty boundary (Denmark/UK median line), not a closure",
    });

    expect(result.success).toBe(true);
  });

  test("a blank decline reason does not count as a reason", () => {
    expect(parse({ status: "declined", declineReason: "   " }).success).toBe(
      false,
    );
  });

  test("a decline reason on an approval is rejected as meaningless", () => {
    const result = parse({ status: "approved", declineReason: "why though" });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("declineReason");
  });

  // A declined area is never drawn, so a season on it would sit in the table
  // looking like a considered judgement about something nobody will ever see.
  test("recurrence on a decline is rejected", () => {
    const result = parse({
      status: "declined",
      declineReason: "not a closure",
      recurrence: { type: "annual", from: "02-01", to: "05-01" },
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("recurrence");
  });

  test("recurrence on an approval is accepted", () => {
    // K 45/2022 — the gýtingarleiðir spawning closure, 1 Feb to 1 May.
    const result = parse({
      status: "approved",
      recurrence: { type: "annual", from: "02-01", to: "05-01" },
    });

    expect(result.success).toBe(true);
  });

  // `pending` is what the SWEEP sets by observing new text. A caller able to
  // set it by hand could forge a source change that never happened.
  test("a caller cannot set a row back to pending", () => {
    expect(parse({ status: "pending" }).success).toBe(false);
  });

  test("an unknown status is rejected", () => {
    expect(parse({ status: "approve" }).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });
});

describe("recurrenceSchema", () => {
  test("accepts a real window", () => {
    expect(
      recurrenceSchema.safeParse({ type: "annual", from: "02-01", to: "05-01" })
        .success,
    ).toBe(true);
  });

  // Allowed on purpose: a window that wraps the year end. None of the three
  // known seasonal closures wrap, but rejecting it would push the next one
  // into being recorded backwards.
  test("accepts a window that wraps the year end", () => {
    expect(
      recurrenceSchema.safeParse({ type: "annual", from: "11-01", to: "03-01" })
        .success,
    ).toBe(true);
  });

  test("accepts 29 February, because the window recurs into leap years", () => {
    expect(
      recurrenceSchema.safeParse({ type: "annual", from: "02-29", to: "05-01" })
        .success,
    ).toBe(true);
  });

  // Both of these parse fine as strings and would silently produce a season
  // that never opens — on a closure whose entire purpose is to be open part of
  // the year.
  test("rejects an impossible month", () => {
    expect(
      recurrenceSchema.safeParse({ type: "annual", from: "13-01", to: "05-01" })
        .success,
    ).toBe(false);
  });

  test("rejects a day that month cannot have", () => {
    expect(
      recurrenceSchema.safeParse({ type: "annual", from: "02-31", to: "05-01" })
        .success,
    ).toBe(false);
    expect(
      recurrenceSchema.safeParse({ type: "annual", from: "04-31", to: "05-01" })
        .success,
    ).toBe(false);
  });

  test("rejects a full date, which is the shape people will reach for", () => {
    expect(
      recurrenceSchema.safeParse({
        type: "annual",
        from: "2026-02-01",
        to: "2026-05-01",
      }).success,
    ).toBe(false);
  });

  // `02-01`-`02-01` is readable as a single day, a whole year, or nothing at
  // all, and those differ enormously to a skipper. Almost always a half-typed
  // range.
  test("rejects a window whose ends are identical", () => {
    const result = recurrenceSchema.safeParse({
      type: "annual",
      from: "02-01",
      to: "02-01",
    });

    expect(result.success).toBe(false);
  });

  test("rejects a non-annual recurrence type", () => {
    expect(
      recurrenceSchema.safeParse({
        type: "monthly",
        from: "02-01",
        to: "05-01",
      }).success,
    ).toBe(false);
  });
});
