import { createHash } from "node:crypto";
import { z } from "zod";
import { REGULATION_FLOW_TYPE } from "./contracts";

// Flowcore's cap is 64,000 bytes, not 64 KiB. Budget includes JSON/base64.
export const SNAPSHOT_PART_EVENT_TYPE = "regulation.case.snapshot.part.1";
export const SNAPSHOT_PART_PATHWAY = `${REGULATION_FLOW_TYPE}/${SNAPSHOT_PART_EVENT_TYPE}`;
export const SNAPSHOT_PART_BYTES = 32_000;
export const SNAPSHOT_EVENT_BUDGET_BYTES = 60_000;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_PARTS = Math.ceil(
  MAX_SNAPSHOT_BYTES / SNAPSHOT_PART_BYTES,
);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const snapshotPartSchema = z.object({
  schemaVersion: z.literal(1),
  assemblyId: z.string().uuid(),
  caseId: z.string().uuid(),
  baseRevisionId: z.string().uuid(),
  revisionId: z.string().uuid(),
  payloadSha256: sha256,
  totalBytes: z.number().int().positive().max(MAX_SNAPSHOT_BYTES),
  totalParts: z.number().int().positive().max(MAX_SNAPSHOT_PARTS),
  partNumber: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_SNAPSHOT_PARTS - 1),
  partSha256: sha256,
  data: z.string().max(Math.ceil(SNAPSHOT_PART_BYTES / 3) * 4),
});
export type SnapshotPart = z.infer<typeof snapshotPartSchema>;
export type SnapshotIdentity = Pick<
  SnapshotPart,
  "assemblyId" | "caseId" | "baseRevisionId" | "revisionId"
>;
export type SnapshotManifest = Omit<
  SnapshotPart,
  "partNumber" | "partSha256" | "data"
>;

export function byteDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function manifestOf(part: SnapshotPart): SnapshotManifest {
  const {
    partNumber: _part,
    partSha256: _hash,
    data: _data,
    ...manifest
  } = part;
  return manifest;
}

export function decodePart(input: unknown): {
  part: SnapshotPart;
  bytes: Buffer;
} {
  const part = snapshotPartSchema.parse(input);
  if (
    part.partNumber >= part.totalParts ||
    part.totalParts !== Math.ceil(part.totalBytes / SNAPSHOT_PART_BYTES) ||
    Buffer.byteLength(JSON.stringify(part), "utf8") >
      SNAPSHOT_EVENT_BUDGET_BYTES
  ) {
    throw new Error("invalid snapshot part bounds");
  }
  const bytes = Buffer.from(part.data, "base64");
  const expectedBytes =
    part.partNumber === part.totalParts - 1
      ? part.totalBytes - part.partNumber * SNAPSHOT_PART_BYTES
      : SNAPSHOT_PART_BYTES;
  // Buffer's decoder is permissive; require a canonical exact byte encoding.
  if (
    bytes.toString("base64") !== part.data ||
    bytes.byteLength !== expectedBytes ||
    byteDigest(bytes) !== part.partSha256
  ) {
    throw new Error("invalid snapshot part bytes or checksum");
  }
  return { part, bytes };
}

export function splitSnapshot(
  identity: SnapshotIdentity,
  snapshot: unknown,
): SnapshotPart[] {
  const serialized = JSON.stringify(snapshot, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("snapshot contains nonfinite number");
    if (
      typeof value === "undefined" ||
      typeof value === "function" ||
      typeof value === "symbol"
    )
      throw new Error("snapshot contains a non-JSON value");
    return value;
  });
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error("snapshot exceeds resource limit");
  }
  const totalParts = Math.ceil(bytes.byteLength / SNAPSHOT_PART_BYTES);
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    ...identity,
    payloadSha256: byteDigest(bytes),
    totalBytes: bytes.byteLength,
    totalParts,
  };
  return Array.from({ length: totalParts }, (_, partNumber) => {
    const data = bytes.subarray(
      partNumber * SNAPSHOT_PART_BYTES,
      (partNumber + 1) * SNAPSHOT_PART_BYTES,
    );
    const part = {
      ...manifest,
      partNumber,
      partSha256: byteDigest(data),
      data: data.toString("base64"),
    };
    decodePart(part);
    return part;
  });
}

export function reconstructSnapshot(
  manifest: SnapshotManifest,
  parts: SnapshotPart[],
): unknown {
  if (parts.length !== manifest.totalParts) {
    throw new Error("incomplete snapshot");
  }
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const buffers = sorted.map((input, index) => {
    const { part, bytes } = decodePart(input);
    if (
      part.partNumber !== index ||
      !manifestsEqual(manifestOf(part), manifest)
    ) {
      throw new Error("conflicting snapshot identity or part sequence");
    }
    return bytes;
  });
  const bytes = Buffer.concat(buffers);
  if (
    bytes.byteLength !== manifest.totalBytes ||
    byteDigest(bytes) !== manifest.payloadSha256
  ) {
    throw new Error("snapshot length or checksum mismatch");
  }
  // Decode once, after reassembly: a multibyte codepoint can span parts.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export function manifestsEqual(
  left: SnapshotManifest,
  right: SnapshotManifest,
): boolean {
  return Object.keys(right).every(
    (key) =>
      left[key as keyof SnapshotManifest] ===
      right[key as keyof SnapshotManifest],
  );
}
