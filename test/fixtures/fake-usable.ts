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

export class FakeUsableServer {
  private server?: Bun.Server<unknown>;
  readonly fragments = new Map<string, Fragment>();
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];

  constructor(private readonly port: number) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.port}/api`;
  }

  async start() {
    await this.stop();
    this.fragments.clear();
    this.calls.length = 0;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/api/, "");
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
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
  }

  async stop(force = false) {
    await this.server?.stop(force);
    this.server = undefined;
  }
}
