/**
 * The status vocabularies for regulation cases, in one place so the read API
 * (stage ② B1), the action events that write them (B2/B3) and the schema
 * comments in `db/schema.ts` cannot drift apart. The columns are plain text
 * — these lists are the contract.
 */

/** Status axis 1 — the regulation itself. */
export const REGULATION_STATUSES = [
  "draft",
  "validated",
  "published",
  "replaced",
  "expired",
] as const;

/** Status axis 2 — the admin case (§12 inbox). */
export const ADMIN_STATUSES = [
  "unread",
  "under_review",
  "awaiting_information",
  "awaiting_regulatory_validation",
  "awaiting_geometry_validation",
  "approved",
  "published",
  "rejected",
  "duplicate",
  "expired",
] as const;

/** Verdict state, mirrored from the current revision onto the case. */
export const VERDICT_STATUSES = ["pending", "ok", "failed"] as const;

export type RegulationStatus = (typeof REGULATION_STATUSES)[number];
export type AdminStatus = (typeof ADMIN_STATUSES)[number];
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];
