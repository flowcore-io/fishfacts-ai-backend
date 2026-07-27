import { z } from "zod";

/**
 * Inbound capture bundle from fishfacts-fe's "Report an issue" flow.
 * Everything except sessionId is optional/defaulted so a partially-captured
 * session still produces a usable report — the FE sends what it has.
 * Reporter identity is NOT accepted here; it is stamped server-side from the
 * authenticated token (same anti-forgery stance as the POI write path).
 */
export const reportMessageSchema = z.object({
  id: z.string().max(100).optional(),
  role: z.string().min(1).max(40),
  content: z.string().max(100_000),
  createdAt: z.string().max(40).optional(),
});

export const reportToolCallSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.string().max(5_000).optional(),
  calledAt: z.string().max(40).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});

export const reportNetworkRequestSchema = z.object({
  method: z.string().min(1).max(10),
  url: z.string().min(1).max(2_000),
  status: z.number().int().optional(),
  ok: z.boolean().optional(),
  error: z.string().max(2_000).optional(),
  startedAt: z.string().max(40).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});

export const reportSubmissionSchema = z.object({
  // Conversation ids are uuid-ish; the charset constraint keeps raw ids safe
  // to interpolate into fragment tags and titles.
  sessionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.:-]+$/, "sessionId must be [A-Za-z0-9_.:-]"),
  userDescription: z.string().max(5_000).optional(),
  contactEmail: z.string().email().max(320).optional(),
  appVersion: z.string().max(100).optional(),
  userAgent: z.string().max(500).optional(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  capturedAt: z.string().max(40).optional(),
  // Hard schema ceilings (well above the FE's own caps) so zod rejects a
  // hostile payload instead of walking millions of nodes; genuine oversize
  // within these bounds is truncated, not rejected (PRD §6.3).
  messages: z.array(reportMessageSchema).max(1_000).default([]),
  toolCalls: z.array(reportToolCallSchema).max(1_000).default([]),
  networkRequests: z.array(reportNetworkRequestSchema).max(1_000).default([]),
});

export type ReportSubmission = z.infer<typeof reportSubmissionSchema>;
export type ReportMessage = z.infer<typeof reportMessageSchema>;
export type ReportToolCall = z.infer<typeof reportToolCallSchema>;
export type ReportNetworkRequest = z.infer<typeof reportNetworkRequestSchema>;

/**
 * Size safety (PRD §6.3): a pathological session (huge tool outputs, endless
 * chat) must be truncated, never rejected. Newest entries win — they are the
 * ones closest to whatever went wrong. Doubles as a data-minimisation control
 * (PRD §7): we keep no more of the session than reproduction needs.
 */
export const CAPTURE_LIMITS = {
  maxMessages: 200,
  maxToolCalls: 200,
  maxNetworkRequests: 300,
  maxMessageContentChars: 20_000,
  maxToolJsonChars: 10_000,
} as const;

export type CaptureTruncation = {
  droppedMessages: number;
  droppedToolCalls: number;
  droppedNetworkRequests: number;
  clippedValues: number;
};

export type TruncatedSubmission = {
  submission: ReportSubmission;
  truncation: CaptureTruncation;
};

export function wasTruncated(truncation: CaptureTruncation): boolean {
  return (
    truncation.droppedMessages > 0 ||
    truncation.droppedToolCalls > 0 ||
    truncation.droppedNetworkRequests > 0 ||
    truncation.clippedValues > 0
  );
}

function clipText(
  value: string,
  maxChars: number,
  counter: { clipped: number },
): string {
  if (value.length <= maxChars) return value;
  counter.clipped += 1;
  return `${value.slice(0, maxChars)}… [truncated ${value.length - maxChars} chars]`;
}

/**
 * Tool args/results arrive as arbitrary JSON. Serialise once, clip once —
 * the fragment renders them as text anyway, and an unserialisable value
 * (cycles) degrades to a marker instead of failing the report.
 */
export function toolJsonAsText(
  value: unknown,
  counter: { clipped: number },
): string | undefined {
  if (value === undefined) return undefined;
  let serialised: string;
  try {
    serialised = JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return "[unserialisable value]";
  }
  return clipText(serialised, CAPTURE_LIMITS.maxToolJsonChars, counter);
}

export function truncateSubmission(
  submission: ReportSubmission,
): TruncatedSubmission {
  const counter = { clipped: 0 };
  const messages = submission.messages
    .slice(-CAPTURE_LIMITS.maxMessages)
    .map((message) => ({
      ...message,
      content: clipText(
        message.content,
        CAPTURE_LIMITS.maxMessageContentChars,
        counter,
      ),
    }));
  const toolCalls = submission.toolCalls.slice(-CAPTURE_LIMITS.maxToolCalls);
  const networkRequests = submission.networkRequests.slice(
    -CAPTURE_LIMITS.maxNetworkRequests,
  );
  return {
    submission: { ...submission, messages, toolCalls, networkRequests },
    truncation: {
      droppedMessages: submission.messages.length - messages.length,
      droppedToolCalls: submission.toolCalls.length - toolCalls.length,
      droppedNetworkRequests:
        submission.networkRequests.length - networkRequests.length,
      clippedValues: counter.clipped,
    },
  };
}
