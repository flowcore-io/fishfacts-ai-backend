import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The wire-format error vocabulary, in one place. Handlers were spelling
 * `{ error: "not_found" }` and friends as inline literals at every call
 * site — dozens of copies of strings that are ALSO a contract: tests assert
 * them, the OpenAPI document names them, and the FE branches on them. A
 * typo'd copy compiles fine and fails as a client that never matches.
 *
 * Tests deliberately keep asserting the literal strings — that pins the wire
 * format itself, so a rename here breaks a test instead of the FE.
 */
export const API_ERROR = {
  missingAuthToken: "missing_auth_token",
  forbidden: "forbidden",
  notFound: "not_found",
  invalidQuery: "invalid_query",
  invalidPayload: "invalid_payload",
  queueUnavailable: "queue_unavailable",
  publishedUnavailable: "published_unavailable",
  poiUnavailable: "poi_unavailable",
  flowcoreWriteFailed: "flowcore_write_failed",
  staleRevision: "stale_revision",
  validationMissing: "validation_missing",
  noSnapshotText: "no_snapshot_text",
  verdictJobRunning: "verdict_job_running",
  reverdictFailed: "reverdict_failed",
} as const;
export type ApiErrorName = (typeof API_ERROR)[keyof typeof API_ERROR];

/** The `reason` values a 400/403 may carry alongside its error name. */
export const API_REASON = {
  adminRequired: "admin_required",
  qTooShort: "q_too_short",
  duplicateOfSelf: "duplicate_of_self",
  duplicateTargetNotFound: "duplicate_target_not_found",
  snoozeUntilInPast: "snooze_until_in_past",
  noChanges: "no_changes",
  missingJustification: "missing_justification",
  justificationForUnchangedField: "justification_for_unchanged_field",
  revisionNotOfCase: "revision_not_of_case",
  geometryNotOfRevision: "geometry_not_of_revision",
} as const;
export type ApiReason = (typeof API_REASON)[keyof typeof API_REASON];

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  error: ApiErrorName,
  extra?: Record<string, unknown>,
) {
  return c.json({ error, ...extra }, status);
}

export const notFound = (c: Context) =>
  errorResponse(c, 404, API_ERROR.notFound);

export const forbiddenAdminRequired = (c: Context) =>
  errorResponse(c, 403, API_ERROR.forbidden, {
    reason: API_REASON.adminRequired,
  });

/** 400 carrying either zod `issues` or a named `reason` (+ fields). */
export const invalidPayload = (
  c: Context,
  extra: { issues: unknown } | { reason: ApiReason; fields?: string[] },
) => errorResponse(c, 400, API_ERROR.invalidPayload, { ...extra });

export const invalidQuery = (
  c: Context,
  extra: { issues: unknown } | { reason: ApiReason },
) => errorResponse(c, 400, API_ERROR.invalidQuery, { ...extra });

export const serviceUnavailable = (
  c: Context,
  error:
    | typeof API_ERROR.queueUnavailable
    | typeof API_ERROR.publishedUnavailable
    | typeof API_ERROR.poiUnavailable,
) => errorResponse(c, 503, error);

export const flowcoreWriteFailed = (c: Context, message: string) =>
  errorResponse(c, 502, API_ERROR.flowcoreWriteFailed, { message });
