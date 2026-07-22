import type { Env } from "@/env";

type JsonObject = Record<string, unknown>;

export type UsableFragment = {
  id: string;
  workspaceId?: string;
  fragmentTypeId?: string;
  key?: string;
  title?: string;
  content?: string;
  tags?: string[];
  frontmatter?: JsonObject;
};

type CreateFragmentInput = {
  workspaceId: string;
  fragmentTypeId: string;
  key: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  createdAt?: string;
};

type UpdateFragmentInput = {
  fragmentTypeId: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
};

function asRecord(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function normalizeFragment(value: unknown): UsableFragment | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const id = typeof obj?.id === "string" ? obj.id : undefined;
  if (!id) return null;
  return {
    id,
    workspaceId:
      typeof obj.workspaceId === "string" ? obj.workspaceId : undefined,
    fragmentTypeId:
      typeof obj.fragmentTypeId === "string" ? obj.fragmentTypeId : undefined,
    key: typeof obj.key === "string" ? obj.key : undefined,
    title: typeof obj.title === "string" ? obj.title : undefined,
    content: typeof obj.content === "string" ? obj.content : undefined,
    tags: Array.isArray(obj.tags)
      ? obj.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined,
    frontmatter: asRecord(obj.frontmatter) ?? undefined,
  };
}

function hasTaggedKey(fragment: UsableFragment, key: string) {
  return (
    fragment.tags?.includes(`fragment-key:${key}`) ||
    fragment.tags?.includes(`state-key:${key}`)
  );
}

function keysFromFragment(fragment: UsableFragment) {
  const keys = new Set<string>();
  if (fragment.key) keys.add(fragment.key);
  for (const tag of fragment.tags ?? []) {
    const match = tag.match(/^fragment-key:(.+)$/);
    if (match?.[1]) keys.add(match[1]);
  }
  if (fragment.content) {
    const match =
      fragment.content.match(/\nkey:\s*"([^"]+)"/) ??
      fragment.content.match(/\nkey:\s*([^\n]+)/);
    if (match?.[1]) keys.add(match[1].trim().replace(/^"|"$/g, ""));
  }
  return keys;
}

function contentHasKey(fragment: UsableFragment, key: string) {
  if (!fragment.content) return false;
  if (fragment.content.includes(`key: "${key}"`)) return true;
  try {
    const parsed = JSON.parse(fragment.content) as Record<string, unknown>;
    return parsed.key === key;
  } catch {
    return false;
  }
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Usable API HTTP ${response.status}: ${text}`);
  }
  return text.trim() ? (JSON.parse(text) as unknown) : {};
}

function parseFragmentEnvelope(json: unknown) {
  const root = asRecord(json);
  const fragment = normalizeFragment(root?.fragment ?? root?.data ?? json);
  if (fragment) return fragment;
  const fragmentId =
    typeof root?.fragmentId === "string" ? root.fragmentId : undefined;
  if (!fragmentId) return null;
  return {
    id: fragmentId,
    key: typeof root?.key === "string" ? root.key : undefined,
  };
}

export class UsableApiClient {
  constructor(private readonly env: Env) {}

  private request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.env.USABLE_API_TOKEN}`);
    if (init.body != null && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${this.env.USABLE_API_BASE_URL}${path}`, {
      ...init,
      headers,
    });
  }

  async getFragmentByKey(workspaceId: string, key: string) {
    const directParams = new URLSearchParams({ workspaceId });
    const direct = await this.request(
      `/memory-fragments/${encodeURIComponent(key)}?${directParams.toString()}`,
    );
    if (direct.ok) {
      return parseFragmentEnvelope(await readJson(direct));
    }

    const params = new URLSearchParams({
      workspaceId,
      limit: "100",
      offset: "0",
    });
    const json = await readJson(
      await this.request(`/memory-fragments?${params.toString()}`),
    );
    const root = asRecord(json);
    const rows = Array.isArray(root?.fragments) ? root.fragments : [];
    const fragments = rows
      .map((row) => normalizeFragment(row))
      .filter((fragment): fragment is UsableFragment => fragment != null);
    return (
      fragments.find((fragment) => fragment.key === key) ??
      fragments.find((fragment) => hasTaggedKey(fragment, key)) ??
      fragments.find((fragment) => contentHasKey(fragment, key)) ??
      null
    );
  }

  async listFragments(input: {
    workspaceId: string;
    fragmentTypeId: string;
    status?: string;
  }) {
    const fragments: UsableFragment[] = [];
    const limit = 500;
    let offset = 0;
    let totalCount = Number.POSITIVE_INFINITY;
    while (offset < totalCount) {
      const params = new URLSearchParams({
        workspaceId: input.workspaceId,
        fragmentTypeId: input.fragmentTypeId,
        limit: String(limit),
        offset: String(offset),
      });
      if (input.status) params.set("status", input.status);
      const json = await readJson(
        await this.request(`/memory-fragments?${params.toString()}`),
      );
      const root = asRecord(json);
      const rows = Array.isArray(root?.fragments) ? root.fragments : [];
      const page = rows
        .map((row) => normalizeFragment(row))
        .filter((fragment): fragment is UsableFragment => fragment != null);
      fragments.push(...page);
      const count = typeof root?.count === "number" ? root.count : page.length;
      totalCount =
        typeof root?.totalCount === "number" ? root.totalCount : offset + count;
      if (count === 0) break;
      offset += count;
    }
    return fragments;
  }

  async listFragmentKeys(input: {
    workspaceId: string;
    fragmentTypeId: string;
    status?: string;
  }) {
    const keys = new Set<string>();
    for (const fragment of await this.listFragments(input)) {
      for (const key of keysFromFragment(fragment)) keys.add(key);
    }
    return keys;
  }

  /**
   * Fetch one fragment by id. The list endpoint returns no frontmatter, so
   * callers needing structured frontmatter (e.g. the POI gazetteer) fetch the
   * fragment detail. Returns null ONLY on 404 (fragment gone — callers may
   * safely skip it); any other failure throws so a transient Usable 5xx is
   * distinguishable from a deletion.
   */
  async getFragmentById(fragmentId: string, workspaceId: string) {
    const params = new URLSearchParams({ workspaceId });
    const resp = await this.request(
      `/memory-fragments/${encodeURIComponent(fragmentId)}?${params.toString()}`,
    );
    if (resp.status === 404) return null;
    const json = await readJson(resp);
    const root = asRecord(json);
    return normalizeFragment(root?.fragment ?? root?.data ?? json);
  }

  async createFragment(input: CreateFragmentInput) {
    const json = await readJson(
      await this.request("/memory-fragments", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    return parseFragmentEnvelope(json);
  }

  async updateFragment(fragmentId: string, input: UpdateFragmentInput) {
    const json = await readJson(
      await this.request(`/memory-fragments/${fragmentId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    );
    return parseFragmentEnvelope(json);
  }
}
