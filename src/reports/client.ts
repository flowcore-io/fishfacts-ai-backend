import type { Env } from "@/env";
import type { UsableApiClient, UsableFragment } from "@/usable/client";
import {
  type ReportScreenshot,
  SCREENSHOT_MIME_EXTENSIONS,
  type ScreenshotMimeType,
} from "./contracts";
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
  /** Path the report was filed from — lets the queue be filtered by screen. */
  route?: string;
  capturedMessageCount?: number;
  capturedToolCallCount?: number;
  capturedNetworkRequestCount?: number;
  truncated?: boolean;
  /**
   * The reporter consented to sending a screenshot. Stamped at write time, so
   * unlike the attachment list it cannot be lost to a failed read — together
   * the two separate "no screenshot was sent" from "one was sent and is
   * missing".
   */
  screenshotSubmitted?: boolean;
};

/** A file attached to a report — in practice the map screenshot. */
export type ReportAttachment = {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  /**
   * Usable-side upload state (`pending`/`active`/`failed` on the attachment).
   * Carried because an upload lands asynchronously: for the first seconds
   * after a report is filed the row exists with no `file` behind it yet, and
   * serving that as a ready attachment produces an image that will not load.
   */
  status?: string;
};

export type ReportDetail = ReportListItem & {
  content: string;
  /** Ground truth for "did the screenshot land", read off the fragment. */
  attachments: ReportAttachment[];
  /**
   * The attachment listing failed, so `attachments` says nothing — as opposed
   * to an empty list, which says there is nothing there. Conflating the two
   * makes one flaky upstream call look like a lost screenshot.
   */
  attachmentsUnavailable?: boolean;
};

export type ReportsClient = {
  create(draft: ReportFragmentDraft): Promise<{ fragmentId: string }>;
  /**
   * Upload the map screenshot and attach it to the report fragment. Resolving
   * means Usable *accepted* the bytes — the upload completes asynchronously on
   * their side, so this is not proof the attachment is servable yet.
   */
  attachScreenshot(
    fragmentId: string,
    screenshot: ReportScreenshot,
  ): Promise<{ fileId: string; status: string }>;
  list(input?: { status?: string }): Promise<ReportListItem[]>;
  get(id: string): Promise<ReportDetail | null>;
  /**
   * Stream one attachment's bytes. Scoped to a report on purpose: the id pair
   * must belong together, so this can never become a proxy for arbitrary
   * workspace files.
   */
  getAttachment(
    reportId: string,
    fileId: string,
  ): Promise<{
    body: ReadableStream<Uint8Array> | null;
    mimeType: string;
  } | null>;
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
    route: asString(meta.route),
    capturedMessageCount: asNumber(meta.capturedMessageCount),
    capturedToolCallCount: asNumber(meta.capturedToolCallCount),
    capturedNetworkRequestCount: asNumber(meta.capturedNetworkRequestCount),
    truncated: typeof meta.truncated === "boolean" ? meta.truncated : undefined,
    screenshotSubmitted: meta.screenshotSubmitted === true ? true : undefined,
  };
}

function extensionFor(mimeType: string): string {
  return SCREENSHOT_MIME_EXTENSIONS[mimeType as ScreenshotMimeType] ?? "bin";
}

/**
 * Only ever an image type. This value becomes the `content-type` the admin
 * browser renders the attachment with, so echoing an arbitrary upstream
 * header here would let a stored file choose how it is interpreted;
 * `application/octet-stream` downloads instead of executing.
 */
function imageMimeOrDefault(mimeType: string | null | undefined): string {
  return mimeType && mimeType in SCREENSHOT_MIME_EXTENSIONS
    ? mimeType
    : "application/octet-stream";
}

/** Attachments carrying a usable file id, in the order Usable returns them. */
async function listReportAttachments(
  usable: UsableApiClient,
  fragmentId: string,
): Promise<ReportAttachment[]> {
  const rows = await usable.listFragmentAttachments(fragmentId);
  return rows.map((row) => ({
    fileId: row.fileId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
  }));
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

    async attachScreenshot(fragmentId, screenshot) {
      // Upload and attach in one call — `fragmentId` on the upload is
      // Usable's own attach-on-upload path, so there is no window where an
      // orphan file exists without the report pointing at it.
      // `status` is carried, not dropped: a 200 here means Usable accepted the
      // bytes (`status: "uploading"`), not that the attachment is servable.
      const { fileId, status } = await usable.uploadFile({
        workspaceId: config.workspaceId,
        fragmentId,
        fileName: `report-${fragmentId}-map.${extensionFor(screenshot.mimeType)}`,
        mimeType: screenshot.mimeType,
        bytes: Buffer.from(screenshot.data, "base64"),
        tags: ["report", "screenshot", "map"],
      });
      return { fileId, status };
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
      // Fail closed: a response missing fragmentTypeId is treated as a
      // mismatch rather than silently disabling the scope check.
      if (fragment.fragmentTypeId !== config.fragmentTypeId) {
        return null;
      }
      // Attachments are a separate read (they are not part of the fragment
      // payload) and are decorative: a report must still open if that call
      // fails.
      let attachments: ReportAttachment[] = [];
      let attachmentsUnavailable = false;
      try {
        attachments = await listReportAttachments(usable, id);
      } catch (error) {
        // "Could not check", NOT "there is nothing there" — an empty list is
        // a claim about the report, and one flaky upstream call must not make
        // an intact screenshot look lost.
        attachmentsUnavailable = true;
        console.error("[Reports] attachment list failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        ...toListItem(fragment),
        content: fragment.content ?? "",
        attachments,
        ...(attachmentsUnavailable ? { attachmentsUnavailable } : {}),
      };
    },

    async getAttachment(reportId, fileId) {
      // Confirm the fragment is a Report AND that this file hangs off it,
      // before any byte is fetched. Without both checks an admin could pull
      // any file in the support workspace through this route.
      const fragment = await usable.getFragmentById(
        reportId,
        config.workspaceId,
      );
      if (!fragment || fragment.fragmentTypeId !== config.fragmentTypeId) {
        return null;
      }
      const attachments = await listReportAttachments(usable, reportId);
      const match = attachments.find(
        (attachment) => attachment.fileId === fileId,
      );
      if (!match) return null;
      const resp = await usable.downloadFile(fileId);
      if (!resp.ok) return null;
      return {
        body: resp.body,
        // Trust the stored metadata over the upstream header, and fall back
        // to a type a browser will not execute.
        mimeType: imageMimeOrDefault(
          match.mimeType ?? resp.headers.get("content-type"),
        ),
      };
    },
  };
}
