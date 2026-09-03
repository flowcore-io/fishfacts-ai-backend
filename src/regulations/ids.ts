import { createHash } from "node:crypto";

/**
 * A UUID derived from a name, stable forever.
 *
 * Case, revision and geometry ids must survive a projection rebuild — a stage
 * ② approval names a revision id, and an id that changes on replay would turn
 * the audit trail into dangling references. So ids are functions of the
 * durable record (case key, event signature), not of when the projector
 * happened to run.
 *
 * RFC 9562 version 8 ("custom") — the version that exists precisely so a
 * deterministic, application-defined UUID does not masquerade as a random v4.
 * `kind` keeps the namespaces apart: the same signature must not produce the
 * same id as a case named identically.
 */
export function deterministicUuid(kind: string, name: string): string {
  const hex = createHash("sha256").update(`${kind}\n${name}`).digest("hex");
  const variant = (
    (Number.parseInt(hex[16] as string, 16) & 0x3) |
    0x8
  ).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function caseIdFor(caseKey: string): string {
  return deterministicUuid("regulation-case", caseKey);
}

export function revisionIdFor(signature: string): string {
  return deterministicUuid("regulation-case-revision", signature);
}

export function geometryIdFor(revisionId: string, position: number): string {
  return deterministicUuid(
    "regulation-case-geometry",
    `${revisionId}#${position}`,
  );
}
