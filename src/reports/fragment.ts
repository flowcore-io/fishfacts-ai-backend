import type { FishfactsUser } from "@/auth/types";
import {
  type CaptureTruncation,
  type ReportSubmission,
  toolJsonAsText,
  wasTruncated,
} from "./contracts";

export type ReportFragmentInput = {
  reportId: string;
  submission: ReportSubmission;
  truncation: CaptureTruncation;
  /** Server-verified from the auth token — never taken from the payload. */
  reporter: FishfactsUser;
  receivedAt: string;
};

export type ReportFragmentDraft = {
  key: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
};

/**
 * YAML scalar via JSON encoding: JSON strings are valid YAML, so user-supplied
 * text (descriptions, session ids) can never break out of the frontmatter.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Fence with more backticks than the longest run inside the content, so a
 * chat message (or tool payload) containing ``` cannot close the fence early
 * and smuggle live markdown into the report — e.g. a forged section that
 * mimics the server-verified metadata block.
 */
/**
 * Sanitiser for short user-controlled scalars rendered OUTSIDE fenced blocks
 * (roles, timestamps, tool names, error lines): newlines and backticks are
 * what let a value break its line/code-span and forge report structure —
 * collapse them. Long payloads (message content, tool JSON, descriptions)
 * are fenced with fencedBlock instead.
 */
function inline(text: string): string {
  return text.replace(/[\r\n`]+/g, " ");
}

function fencedBlock(text: string, lang = ""): string {
  const longestRun = text
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, (longestRun ?? 0) + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

function frontmatterLines(
  input: ReportFragmentInput,
  truncation: CaptureTruncation,
): string[] {
  const { submission, reporter } = input;
  const lines = [
    "---",
    "status: reported",
    `reportId: ${yamlString(input.reportId)}`,
    `reportedAt: ${yamlString(input.receivedAt)}`,
    `sessionId: ${yamlString(submission.sessionId)}`,
    `fishfactsUserId: ${reporter.id}`,
    `fishfactsUsername: ${yamlString(reporter.username)}`,
    `reporterName: ${yamlString(`${reporter.firstName} ${reporter.lastName}`.trim())}`,
  ];
  if (submission.contactEmail) {
    lines.push(`contactEmail: ${yamlString(submission.contactEmail)}`);
  }
  if (submission.appVersion) {
    lines.push(`appVersion: ${yamlString(submission.appVersion)}`);
  }
  lines.push(
    `capturedMessageCount: ${submission.messages.length}`,
    `capturedToolCallCount: ${submission.toolCalls.length}`,
    `capturedNetworkRequestCount: ${submission.networkRequests.length}`,
    `truncated: ${wasTruncated(truncation)}`,
    "---",
  );
  return lines;
}

/**
 * Deterministic ingestion-time summary (PRD §5.3): enough for an agent to
 * search/skim the queue without opening the raw capture. No LLM involved —
 * this backend has no inference; counts + tool mix + failure signals only.
 */
function buildSummary(input: ReportFragmentInput): string {
  const { submission, reporter } = input;
  const toolNames = [...new Set(submission.toolCalls.map((call) => call.tool))];
  const failedCalls = submission.toolCalls.filter((call) => call.error).length;
  const failedRequests = submission.networkRequests.filter(
    (request) => request.error || (request.status ?? 0) >= 400,
  ).length;
  const parts = [
    `${reporter.username} reported an issue in chat session ${submission.sessionId}.`,
    `Captured ${submission.messages.length} messages, ${submission.toolCalls.length} tool calls and ${submission.networkRequests.length} FE network requests.`,
  ];
  if (toolNames.length > 0) {
    parts.push(`Tools used: ${toolNames.slice(0, 8).join(", ")}.`);
  }
  if (failedCalls > 0) parts.push(`${failedCalls} tool call(s) errored.`);
  if (failedRequests > 0) {
    parts.push(`${failedRequests} network request(s) failed.`);
  }
  if (submission.userDescription) {
    // Collapse whitespace — the summary is one-line fragment metadata.
    parts.push(
      `User description: ${submission.userDescription.replace(/\s+/g, " ")}`,
    );
  }
  return parts.join(" ");
}

function messageSection(submission: ReportSubmission): string[] {
  if (submission.messages.length === 0) return ["_No messages captured._"];
  return submission.messages.map((message) => {
    const stamp = message.createdAt ? ` (${inline(message.createdAt)})` : "";
    return `**${inline(message.role)}**${stamp}:\n\n${fencedBlock(message.content)}`;
  });
}

function toolCallSection(
  submission: ReportSubmission,
  counter: { clipped: number },
): string[] {
  if (submission.toolCalls.length === 0) return ["_No tool calls captured._"];
  return submission.toolCalls.map((call, index) => {
    const lines = [`### ${index + 1}. \`${inline(call.tool)}\``];
    const meta: string[] = [];
    if (call.calledAt) meta.push(`at ${inline(call.calledAt)}`);
    if (call.durationMs !== undefined) meta.push(`${call.durationMs}ms`);
    if (meta.length > 0) lines.push(meta.join(" · "));
    const args = toolJsonAsText(call.args, counter);
    if (args !== undefined) {
      lines.push(`Input:\n\n${fencedBlock(args, "json")}`);
    }
    const result = toolJsonAsText(call.result, counter);
    if (result !== undefined) {
      lines.push(`Result:\n\n${fencedBlock(result, "json")}`);
    }
    if (call.error) lines.push(`Error:\n\n${fencedBlock(call.error)}`);
    return lines.join("\n\n");
  });
}

function networkSection(submission: ReportSubmission): string[] {
  if (submission.networkRequests.length === 0) {
    return ["_No network requests captured._"];
  }
  const rows = submission.networkRequests.map((request) => {
    const status =
      request.status !== undefined
        ? String(request.status)
        : request.error
          ? "ERR"
          : "?";
    const duration =
      request.durationMs !== undefined ? `${request.durationMs}ms` : "";
    const error = request.error ? ` — ${inline(request.error)}` : "";
    // Backticks stripped so a crafted url can't break the inline code span.
    const url = request.url.replace(/`/g, "'");
    return `- \`${inline(request.method)} ${url}\` → ${status} ${duration}${error}`;
  });
  return rows;
}

function truncationNote(truncation: CaptureTruncation): string[] {
  if (!wasTruncated(truncation)) return [];
  return [
    "## Truncation",
    `Capture was truncated to bound payload size: dropped ${truncation.droppedMessages} oldest message(s), ${truncation.droppedToolCalls} oldest tool call(s), ${truncation.droppedNetworkRequests} oldest network request(s); clipped ${truncation.clippedValues} oversized value(s).`,
  ];
}

export function buildReportFragment(
  input: ReportFragmentInput,
): ReportFragmentDraft {
  const { submission, reporter } = input;
  // Body sections are built BEFORE the frontmatter: tool-JSON clipping
  // happens while rendering them, and its count must land in the same
  // `truncated`/`clippedValues` accounting the frontmatter reports.
  const counter = { clipped: 0 };
  const chatLog = messageSection(submission);
  const toolCalls = toolCallSection(submission, counter);
  const networkRequests = networkSection(submission);
  const truncation: CaptureTruncation = {
    ...input.truncation,
    clippedValues: input.truncation.clippedValues + counter.clipped,
  };
  const summary = buildSummary(input);
  const sections = [
    ...frontmatterLines(input, truncation),
    "",
    "## Summary",
    summary,
    "",
    "## User description",
    // Fenced like the chat log — a description can forge report structure
    // just as easily as a message can.
    submission.userDescription
      ? fencedBlock(submission.userDescription)
      : "_None provided._",
    "",
    "## Session metadata",
    [
      `- Reported by: ${reporter.username} (FishFacts user ${reporter.id}, verified via auth token)`,
      `- Received at: ${input.receivedAt}`,
      submission.capturedAt
        ? `- Captured at: ${inline(submission.capturedAt)}`
        : null,
      submission.appVersion
        ? `- App version: ${inline(submission.appVersion)}`
        : null,
      submission.userAgent
        ? `- User agent: ${inline(submission.userAgent)}`
        : null,
      submission.viewport
        ? `- Viewport: ${submission.viewport.width}×${submission.viewport.height}`
        : null,
      submission.contactEmail
        ? `- Contact email (user-supplied): ${submission.contactEmail}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    "",
    ...truncationNote(truncation),
    "",
    "## Chat log",
    ...chatLog,
    "",
    "## Tool calls",
    ...toolCalls,
    "",
    "## Network requests",
    ...networkRequests,
    "",
    "## Backend trace",
    // Honest V1 scope (PRD §6.2): chat inference runs in the usable-chat
    // platform, not this backend, so there is no per-session LLM trace store
    // to join against yet. What IS server-side: the verified reporter
    // identity above and the ingest timestamp. Extend here when a session
    // trace source exists.
    "_No backend-side session trace source is available in V1 — the capture above is the FE-observed record. Reporter identity and receive time are server-verified._",
  ];
  const reportedDate = input.receivedAt.slice(0, 10);
  return {
    key: `report-${input.reportId}`,
    title: `[FishFacts Report] ${reportedDate} — ${reporter.username} — ${submission.sessionId}`,
    summary,
    content: sections.join("\n"),
    tags: [
      "report",
      "status:reported",
      "project:fishfacts-reports",
      "repo:fishfacts-fe",
      `session:${submission.sessionId}`,
    ],
  };
}
