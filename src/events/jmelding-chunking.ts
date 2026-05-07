import type { JMeldingAnnouncementDiscovered } from "./contracts";

export const MAX_EVENT_SIZE_BYTES = 60_000;
export const CHUNK_BODY_SIZE_CHARS = 50_000;
export const MAX_TOTAL_BODY_CHARS = 500_000;

function eventByteSize(event: JMeldingAnnouncementDiscovered): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function splitBody(body: string, chunkSize: number): string[] {
  if (body.length === 0) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    chunks.push(body.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function stripChunkFields(
  item: JMeldingAnnouncementDiscovered,
): JMeldingAnnouncementDiscovered {
  const { partNumber: _partNumber, totalParts: _totalParts, ...rest } = item;
  return rest;
}

export function chunkAnnouncement(
  item: JMeldingAnnouncementDiscovered,
): JMeldingAnnouncementDiscovered[] {
  const cappedBody = (item.bodyMarkdown ?? "").slice(0, MAX_TOTAL_BODY_CHARS);
  const single = stripChunkFields({ ...item, bodyMarkdown: cappedBody });
  if (eventByteSize(single) <= MAX_EVENT_SIZE_BYTES) return [single];

  const bodyChunks = splitBody(cappedBody, CHUNK_BODY_SIZE_CHARS);
  const totalParts = bodyChunks.length;
  const base = stripChunkFields(item);
  return bodyChunks.map((chunk, index) => ({
    ...base,
    bodyMarkdown: chunk,
    partNumber: index + 1,
    totalParts,
  }));
}

export function isChunked(item: JMeldingAnnouncementDiscovered): boolean {
  return typeof item.totalParts === "number" && item.totalParts > 1;
}

export function reassembleAnnouncement(
  parts: JMeldingAnnouncementDiscovered[],
): JMeldingAnnouncementDiscovered {
  if (parts.length === 0) {
    throw new Error("reassembleAnnouncement called with no parts");
  }
  const sorted = [...parts].sort(
    (a, b) => (a.partNumber ?? 1) - (b.partNumber ?? 1),
  );
  const bodyMarkdown = sorted.map((part) => part.bodyMarkdown ?? "").join("");
  return stripChunkFields({ ...sorted[0], bodyMarkdown });
}
