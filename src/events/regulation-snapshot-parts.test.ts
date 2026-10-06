import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_EVENT_BUDGET_BYTES,
  SNAPSHOT_PART_BYTES,
  byteDigest,
  decodePart,
  manifestOf,
  reconstructSnapshot,
  splitSnapshot,
} from "./regulation-snapshot-parts";

const identity = () => ({
  assemblyId: randomUUID(),
  caseId: randomUUID(),
  baseRevisionId: randomUUID(),
  revisionId: randomUUID(),
});

describe("lossless revision byte transport", () => {
  test("escaped/multibyte full snapshots survive reordered parts without decode per part", () => {
    const ids = identity();
    const snapshot = {
      ...ids,
      snapshotText: '😀 Øst "\\\n'.repeat(25_000),
      points: [{ lat: 70.941667, lon: 25.688333 }],
      polygons: [
        [
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      ],
    };
    const parts = splitSnapshot(ids, snapshot);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(
        SNAPSHOT_EVENT_BUDGET_BYTES,
      );
      expect(decodePart(part).bytes.length).toBeLessThanOrEqual(
        SNAPSHOT_PART_BYTES,
      );
    }
    // Simulate a JSONB manifest's unrelated object-key order.
    const reordered = Object.fromEntries(
      Object.entries(manifestOf(parts[0])).reverse(),
    ) as ReturnType<typeof manifestOf>;
    expect(reconstructSnapshot(reordered, [...parts].reverse())).toEqual(
      snapshot,
    );
  });

  test("incomplete, duplicate sequence, corrupted data and foreign headers fail", () => {
    const ids = identity();
    const parts = splitSnapshot(ids, { ...ids, text: "x".repeat(80_000) });
    const manifest = manifestOf(parts[0]);
    expect(() => reconstructSnapshot(manifest, parts.slice(1))).toThrow(
      "incomplete",
    );
    expect(() =>
      reconstructSnapshot(manifest, [parts[0], parts[0], parts[2]]),
    ).toThrow();
    expect(() =>
      decodePart({ ...parts[0], data: `${parts[0].data.slice(0, -4)}AAAA` }),
    ).toThrow();
    expect(() =>
      reconstructSnapshot(manifest, [
        { ...parts[0], revisionId: randomUUID() },
        ...parts.slice(1),
      ]),
    ).toThrow("conflicting");
    const bytes = Buffer.from(parts[0].data, "base64");
    bytes[100] ^= 1;
    const corrupted = {
      ...parts[0],
      data: bytes.toString("base64"),
      partSha256: byteDigest(bytes),
    };
    expect(() =>
      reconstructSnapshot(manifest, [corrupted, ...parts.slice(1)]),
    ).toThrow("checksum");
  });

  test("rejects oversized and noncanonical envelopes instead of truncating", () => {
    const ids = identity();
    expect(() =>
      splitSnapshot(ids, { text: "x".repeat(MAX_SNAPSHOT_BYTES) }),
    ).toThrow("resource limit");
    const [part] = splitSnapshot(ids, { ...ids });
    expect(() => decodePart({ ...part, data: `${part.data}\n` })).toThrow(
      "bytes",
    );
    expect(() => decodePart({ ...part, partNumber: part.totalParts })).toThrow(
      "bounds",
    );
  });
});

test("snapshot writer refuses values JSON would silently discard or replace", () => {
  const ids = {
    assemblyId: randomUUID(),
    caseId: randomUUID(),
    baseRevisionId: randomUUID(),
    revisionId: randomUUID(),
  };
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    () => 1,
  ])
    expect(() => splitSnapshot(ids, { position: value })).toThrow();
});
