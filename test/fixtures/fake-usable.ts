import { randomUUID } from "node:crypto";

type Fragment = {
  id: string;
  workspaceId: string;
  fragmentTypeId?: string;
  key?: string;
  title: string;
  summary?: string;
  content: string;
  tags?: string[];
  createdAt?: string;
};

type StoredFile = {
  fileId: string;
  workspaceId: string;
  fragmentId?: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  tags: string[];
};

export class FakeUsableServer {
  private server?: Bun.Server<unknown>;
  readonly fragments = new Map<string, Fragment>();
  readonly files = new Map<string, StoredFile>();
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /**
   * The ingestion embed chat (`POST <baseUrl>/embed-chat?token=…`), answered
   * from a script. Ingestion never calls a model provider directly — it goes
   * through the embed, which is the billing boundary — so this is the one
   * seam a job's model turn can be faked at.
   *
   * Answers are served in the order they were queued, and the prompt of every
   * call is recorded, so a test can assert WHICH case texts the model saw and
   * in what order. An empty queue answers 503: a missing script is a loud
   * transport failure, never a silently empty answer.
   */
  readonly embedChatPrompts: string[] = [];
  private readonly embedChatAnswers: string[] = [];
  /** Set to make `POST /files/upload` fail, to exercise the degraded path. */
  failUploads = false;
  /** Set to make the attachment listing fail (a transient upstream 5xx). */
  failAttachmentList = false;

  constructor(private readonly port: number) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}/api`;
  }

  async start() {
    await this.stop();
    this.fragments.clear();
    this.files.clear();
    this.failUploads = false;
    this.failAttachmentList = false;
    this.calls.length = 0;
    this.embedChatPrompts.length = 0;
    this.embedChatAnswers.length = 0;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/api/, "");
        if (path === "/embed-chat" && request.method === "POST") {
          const body = (await request.json()) as {
            messages?: Array<{ content?: string }>;
          };
          this.embedChatPrompts.push(body.messages?.[0]?.content ?? "");
          this.calls.push({ method: "POST", path: url.pathname });
          const answer = this.embedChatAnswers.shift();
          if (answer === undefined) {
            return Response.json(
              { error: "no_answer_queued" },
              { status: 503 },
            );
          }
          return new Response(embedChatStream(answer), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (path === "/memory-fragments" && request.method === "GET") {
          const workspaceId = url.searchParams.get("workspaceId") ?? "";
          const key = url.searchParams.get("key") ?? undefined;
          const fragmentTypeId =
            url.searchParams.get("fragmentTypeId") ?? undefined;
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const fragments = Array.from(this.fragments.values()).filter(
            (fragment) =>
              fragment.workspaceId === workspaceId &&
              (!key || fragment.key === key) &&
              (!fragmentTypeId || fragment.fragmentTypeId === fragmentTypeId),
          );
          this.calls.push({ method: "GET", path: url.pathname });
          return Response.json({
            fragments: fragments.slice(offset, offset + limit),
            count: fragments.slice(offset, offset + limit).length,
            totalCount: fragments.length,
            pagination: { limit, offset },
          });
        }
        if (path === "/memory-fragments" && request.method === "POST") {
          const body = (await request.json()) as Omit<Fragment, "id">;
          this.calls.push({ method: "POST", path: url.pathname, body });
          if (
            body.key &&
            Array.from(this.fragments.values()).some(
              (fragment) =>
                fragment.workspaceId === body.workspaceId &&
                fragment.key === body.key,
            )
          ) {
            return Response.json({ error: "Duplicate key" }, { status: 409 });
          }
          const fragment = { ...body, id: randomUUID() };
          this.fragments.set(fragment.id, fragment);
          return Response.json({ success: true, fragment }, { status: 201 });
        }
        const patchMatch = path.match(/^\/memory-fragments\/([^/]+)$/);
        if (patchMatch && request.method === "GET") {
          const idOrKey = decodeURIComponent(patchMatch[1]);
          const workspaceId = url.searchParams.get("workspaceId") ?? "";
          const existing =
            this.fragments.get(idOrKey) ??
            Array.from(this.fragments.values()).find(
              (fragment) =>
                fragment.workspaceId === workspaceId &&
                fragment.key === idOrKey,
            );
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          this.calls.push({ method: "GET", path: url.pathname });
          return Response.json({ success: true, fragment: existing });
        }
        if (patchMatch && request.method === "PATCH") {
          const id = patchMatch[1];
          const existing = this.fragments.get(id);
          if (!existing)
            return Response.json({ error: "not_found" }, { status: 404 });
          const body = (await request.json()) as Partial<Fragment>;
          this.calls.push({ method: "PATCH", path: url.pathname, body });
          const updated = { ...existing, ...body, id };
          this.fragments.set(id, updated);
          return Response.json({ success: true, fragment: updated });
        }
        // --- Files (upload-and-attach, list, download) --------------------
        // Mirrors Usable's real routes: one multipart POST both stores the
        // file and attaches it when `fragmentId` is present; attachments are
        // read from `/fragments/:id/files`, NOT from the fragment itself.
        if (path === "/files/upload" && request.method === "POST") {
          this.calls.push({ method: "POST", path: url.pathname });
          if (this.failUploads) {
            return Response.json({ error: "upload_failed" }, { status: 500 });
          }
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File)) {
            return Response.json({ error: "file required" }, { status: 400 });
          }
          const fileId = randomUUID().replace(/-/g, "").slice(0, 12);
          const tags = form.get("tags");
          this.files.set(fileId, {
            fileId,
            workspaceId: String(form.get("workspaceId") ?? ""),
            fragmentId: (form.get("fragmentId") as string | null) ?? undefined,
            name: file.name,
            mimeType: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
            tags: typeof tags === "string" ? JSON.parse(tags) : [],
          });
          return Response.json({
            success: true,
            fileId,
            status: "uploading",
            message: "File upload initiated",
          });
        }
        const attachmentsMatch = path.match(/^\/fragments\/([^/]+)\/files$/);
        if (attachmentsMatch && request.method === "GET") {
          const fragmentId = decodeURIComponent(attachmentsMatch[1]);
          this.calls.push({ method: "GET", path: url.pathname });
          if (this.failAttachmentList) {
            return Response.json({ error: "upstream" }, { status: 503 });
          }
          const attachments = Array.from(this.files.values())
            .filter((file) => file.fragmentId === fragmentId)
            .map((file) => ({
              id: randomUUID(),
              fileId: file.fileId,
              fragmentId,
              status: "active",
              displayOrder: 0,
              file: {
                id: file.fileId,
                name: file.name,
                mimeType: file.mimeType,
                sizeBytes: file.bytes.byteLength,
                tags: file.tags,
              },
            }));
          return Response.json({ success: true, attachments });
        }
        const downloadMatch = path.match(/^\/files\/([^/]+)\/download$/);
        if (downloadMatch && request.method === "GET") {
          const file = this.files.get(decodeURIComponent(downloadMatch[1]));
          this.calls.push({ method: "GET", path: url.pathname });
          if (!file)
            return Response.json({ error: "not_found" }, { status: 404 });
          return new Response(new Uint8Array(file.bytes), {
            headers: { "content-type": file.mimeType },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
  }

  /** Queue one answer for the next embed chat turn, in call order. */
  queueEmbedChatAnswer(...answers: string[]) {
    this.embedChatAnswers.push(...answers);
    return this;
  }

  async stop(force = false) {
    await this.server?.stop(force);
    this.server = undefined;
  }
}

/**
 * The real embed answers as SSE: `text-delta` frames carry the text,
 * `token-usage` names the model, and `stream-end` must say `completed` or the
 * client refuses the answer as possibly truncated. Split in two deltas on
 * purpose — an assembler that only reads the first frame has to fail here.
 */
function embedChatStream(answer: string): string {
  const half = Math.ceil(answer.length / 2);
  const frames = [
    { type: "intent", data: {} },
    { type: "text-delta", data: { textDelta: answer.slice(0, half) } },
    { type: "text-delta", data: { textDelta: answer.slice(half) } },
    { type: "token-usage", data: { model: "fake/test-model" } },
    { type: "stream-end", data: { status: "completed" } },
  ];
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\n`;
}

/**
 * A stored fragment's YAML frontmatter, parsed the way any Usable reader
 * would — so a test can assert what a synced fragment SAYS without importing
 * the app's own parser. null when there is no block or it does not parse.
 */
export function frontmatterOf(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  try {
    return Bun.YAML.parse(match[1] ?? "") as Record<string, unknown>;
  } catch {
    return null;
  }
}
