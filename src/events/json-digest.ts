import { createHash } from "node:crypto";

/** Versioned contracts choose their own JSON shape; this helper only fixes
 * key ordering/finite-number serialization. Arrays retain source order. */
export function canonicalJson(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (typeof v === "number" && !Number.isFinite(v))
      throw new Error("nonfinite canonical number");
    if (v === null || ["string", "boolean", "number"].includes(typeof v))
      return v;
    if (Array.isArray(v)) return v.map(visit);
    if (
      typeof v === "object" &&
      v &&
      Object.getPrototypeOf(v) === Object.prototype
    )
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, visit((v as Record<string, unknown>)[key])]),
      );
    throw new Error("not a canonical JSON value");
  };
  return JSON.stringify(visit(value));
}
export const sha256Text = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const canonicalDigest = (value: unknown) =>
  sha256Text(canonicalJson(value));
