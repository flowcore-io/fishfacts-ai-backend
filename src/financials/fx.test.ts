import { describe, expect, it } from "bun:test";
import { FxRates } from "./fx";

describe("fx convert (EUR-based cross)", () => {
  // db is unused by convert() — cast a stub.
  const fx = new FxRates({} as never);
  const rates = new Map([
    ["EUR", 1],
    ["DKK", 7.4529],
    ["ISK", 150.5],
  ]);

  it("converts to/from EUR and cross-currency", () => {
    expect(fx.convert(100, "EUR", "DKK", rates)).toBeCloseTo(745.29, 2);
    expect(fx.convert(170924, "EUR", "DKK", rates)).toBeCloseTo(
      170924 * 7.4529,
      5,
    );
    // 1505 ISK → EUR 10 → DKK 74.529
    expect(fx.convert(1505, "ISK", "DKK", rates)).toBeCloseTo(74.529, 2);
  });

  it("is a no-op for same currency and null for unknown", () => {
    expect(fx.convert(50, "EUR", "EUR", rates)).toBe(50);
    expect(fx.convert(50, "EUR", "XXX", rates)).toBeNull();
    expect(fx.convert(50, "XXX", "DKK", rates)).toBeNull();
  });
});
