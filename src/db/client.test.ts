import { describe, expect, test } from "bun:test";
import { timestampToIso } from "./client";

describe("timestampToIso", () => {
  test("a Date passes through as an instant", () => {
    expect(timestampToIso(new Date("2023-07-07T00:00:00.000Z"))).toBe(
      "2023-07-07T00:00:00.000Z",
    );
  });

  test("Postgres' own rendering normalises to the same instant", () => {
    // The shape the driver actually returns — space separator, `+00` offset.
    // `Date.parse` handling of this form is implementation-defined, so this
    // pins it for the runtime we ship on rather than assuming.
    expect(timestampToIso("2023-07-07 00:00:00+00")).toBe(
      "2023-07-07T00:00:00.000Z",
    );
    expect(timestampToIso("2023-07-31 23:59:59.999+00")).toBe(
      "2023-07-31T23:59:59.999Z",
    );
  });

  test("an empty column is absent, not the epoch", () => {
    expect(timestampToIso(null)).toBeUndefined();
    expect(timestampToIso(undefined)).toBeUndefined();
  });

  test("an uninterpretable value is surfaced, never silently dropped", () => {
    // The one behaviour the docstring promises, and the one nothing covered.
    // Dropping instead would leave `bun test` green while rows the fragment
    // sync reasons about flip verdict — a Vørn `valid_from: "í dag, hin 22"`
    // would read as in-sync and never get cleaned.
    expect(timestampToIso("í dag, hin 22")).toBe("í dag, hin 22");
    expect(timestampToIso("not a timestamp")).toBe("not a timestamp");
  });
});
