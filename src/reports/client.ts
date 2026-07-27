import type { Env } from "@/env";
import type { UsableApiClient, UsableFragment } from "@/usable/client";
import type { ReportFragmentDraft } from "./fragment";

export type ReportListItem = {
  id: string;
  title: string;
  status: string;
  reportedAt?: string;
  sessionId?: string;
  reporter: {
    fishfactsUserId?: number;
    username?: string;
  };
  /** User-supplied follow-up address — NOT a verified identity field. */
  contactEmail?: string;
  appVersion?: string;
  capturedMessageCount?: number;
  capturedToolCallCount?: number;
  capturedNetworkRequestCount?: number;
  truncated?: boolean;
};

export type ReportDetail = ReportListItem & {
  content: string;
};

export type ReportsClient = {
  create(draft: ReportFragmentDraft): Promise<{ fragmentId: string }>;
  list(input?: { status?: string }): Promise<ReportListItem[]>;
  get(id: string): Promise<ReportDetail | null>;
};

export type ReportsConfig = {
  workspaceId: string;
  fragmentTypeId: string;
};

/**
 * Reports live in a dedicated Usable fragment type (support-scoped
 * workspace). Both ids come from env so the storage target can move without
 * a code change; when the fragment type isn't configured the feature is off
 * and the routes answer 503 (reportsConfigFromEnv returns null).
 */
export function reportsConfigFromEnv(env: Env): ReportsConfig | null {
  if (!env.REPORT_FRAGMENT_TYPE_ID) return null;
  return {
    workspaceId: env.REPORT_WORKSPACE_ID ?? env.USABLE_WORKSPACE_ID,
    fragmentTypeId: env.REPORT_FRAGMENT_TYPE_ID,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function toListItem(fragment: UsableFragment): ReportListItem {
  const meta = fragment.frontmatter ?? {};
  return {
    id: fragment.id,
    title: fragment.title ?? "(untitled report)",
    status: asString(meta.status) ?? "reported",
    reportedAt: asString(meta.reportedAt),
    sessionId: asString(meta.sessionId),
    reporter: {
      fishfactsUserId: asNumber(meta.fishfactsUserId),
      username: asString(meta.fishfactsUsername),
    },
    contactEmail: asString(meta.contactEmail),
    appVersion: asString(meta.appVersion),
    capturedMessageCount: asNumber(meta.capturedMessageCount),
    capturedToolCallCount: asNumber(meta.capturedToolCallCount),
    capturedNetworkRequestCount: asNumber(meta.capturedNetworkRequestCount),
    truncated: typeof meta.truncated === "boolean" ? meta.truncated : undefined,
  };
}

export function makeReportsClient(
  usable: UsableApiClient,
  config: ReportsConfig,
): ReportsClient {
  return {
    async create(draft) {
      const created = await usable.createFragment({
        workspaceId: config.workspaceId,
        fragmentTypeId: config.fragmentTypeId,
        key: draft.key,
        title: draft.title,
        summary: draft.summary,
        content: draft.content,
        tags: draft.tags,
      });
      if (!created) {
        throw new Error("Usable createFragment returned no fragment id");
      }
      return { fragmentId: created.id };
    },

    async list(input) {
      const fragments = await usable.listFragments({
        workspaceId: config.workspaceId,
        fragmentTypeId: config.fragmentTypeId,
      });
      const reports = fragments.map(toListItem);
      const filtered = input?.status
        ? reports.filter((report) => report.status === input.status)
        : reports;
      // Newest first — the queue is worked from the most recent report.
      return filtered.sort((a, b) =>
        (b.reportedAt ?? "").localeCompare(a.reportedAt ?? ""),
      );
    },

    async get(id) {
      const fragment = await usable.getFragmentById(id, config.workspaceId);
      if (!fragment) return null;
      // The proxy serves Report fragments only — an arbitrary fragment id
      // from the same workspace (POI, job state, …) must 404, not leak.
      if (
        fragment.fragmentTypeId &&
        fragment.fragmentTypeId !== config.fragmentTypeId
      ) {
        return null;
      }
      return { ...toListItem(fragment), content: fragment.content ?? "" };
    },
  };
}
