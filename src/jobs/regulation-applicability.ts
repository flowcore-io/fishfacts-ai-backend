import { randomUUID } from "node:crypto";
import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import {
  buildApplicabilityMessages,
  parseApplicabilityAnswer,
  statedDimensionsOf,
} from "@/regulations/applicability-extraction";
import type {
  ApplicabilityCandidateCase,
  RegulationQueueRepository,
} from "@/regulations/queue-repository";
import { type UsableFragment, bodyFromContent } from "@/usable/client";
import type { EmbedChatAnswer, EmbedChatMessage } from "@/usable/embed-chat";
import type { JobExecutionResult, JobState } from "./types";

/** The actor every revision this job proposes is stamped with. An admin
 * reading the history has to be able to tell a machine's reading from a
 * colleague's edit at a glance — and only a human ever approves either. */
export const APPLICABILITY_ACTOR = "job:regulation-applicability";

/**
 * One stateless embed chat turn — a seam, so the job is tested against a fake
 * with no key, no network and no spend. The interesting failures are in what
 * we do with the answer.
 */
export type ApplicabilityChat = (
  messages: EmbedChatMessage[],
) => Promise<EmbedChatAnswer>;

/** The slice of the Usable client this job needs, named so it can be faked. */
export type RegulationApplicabilityUsable = {
  getFragmentById(
    fragmentId: string,
    workspaceId: string,
  ): Promise<UsableFragment | null>;
};

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
};

/** Why a case produced no proposal. Every one of them names the case in the
 * run result — a case that cannot be read is REPORTED, never skipped
 * silently, because silence is indistinguishable from "nothing to say". */
export type ApplicabilityRunFailureReason =
  | "no_source_text"
  | "source_unreadable"
  | "chat_error"
  | "unparseable"
  | "quote_not_in_source"
  | "value_not_in_source"
  | "stale_base"
  | "projection_pending";

/** The source fragment is there but came back without content — transient,
 * like a failed chat turn, and named apart from one so a run's output does
 * not blame the model for the corpus. */
class SourceUnreadableError extends Error {}

/** How long the job waits for its own proposal to appear before deciding
 * what happened to it. The handler is local and normally lands in
 * milliseconds; this covers the case where the pathways wait timed out with
 * the event already durable, and the projection is still catching up. */
const POINTER_POLL_INTERVAL_MS = 250;
const POINTER_POLL_TIMEOUT_MS = 10_000;

export type ApplicabilityRunResult = {
  /** A human sentence, so the job-state screen reads as prose even though
   * the payload around it is structured. */
  summary: string;
  dryRun: boolean;
  proposed: Array<{
    caseKey: string;
    title: string;
    /** null on a dry run — this is what WOULD have been proposed. */
    revisionId: string | null;
  }>;
  failed: Array<{
    caseKey: string;
    title: string;
    reason: ApplicabilityRunFailureReason;
    detail?: string;
  }>;
};

/**
 * 🧭 Applicability proposals for regulation cases that have none.
 *
 * For each candidate case, read its stored source text, ask the model
 * (through the Usable Chat embed — the billing boundary) who the rule applies
 * to, and propose the answer as a revision that changes ONLY
 * `fields.applicability`. An admin confirms or corrects it before the case is
 * approved; nothing here ever publishes anything.
 *
 * Outcomes per case, deliberately distinct:
 * - a schema-valid answer whose every stated dimension carries a verbatim
 *   source quote → a `revision.proposed` event;
 * - no source text at all, an unparseable answer, a quote that is not in the
 *   source, or a value the source never printed → NO event, and the case
 *   named in `failed` with the reason.
 *   These are durable facts about the case, and a human has to see them;
 * - a transport error (`chat_error`: the embed unreachable) or a corpus
 *   fragment that came back contentless (`source_unreadable`) → no event
 *   either. Those are not facts about the text, so nothing is recorded
 *   against the case and the next run retries it.
 *
 * Bounded by `limit` because each case costs an LLM call and the first-run
 * backlog is every case ever ingested. Manual only: a job that decides who a
 * law applies to earns a schedule after someone has read what it says.
 *
 * Re-extraction (an explicit `caseKeys` list) proposes even when the answer
 * matches the applicability already stored: naming a case is a human asking
 * for the reading to be redone, and a revision that says the same thing is
 * still the record of that.
 */
export function createRegulationApplicabilityJob(
  env: Env,
  writer: PathwayWriter,
  usable: RegulationApplicabilityUsable,
  queue: RegulationQueueRepository,
  chat: ApplicabilityChat,
  /** Test seam: the pointer read-back's patience, in milliseconds. */
  polling: {
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  const pollIntervalMs = polling.intervalMs ?? POINTER_POLL_INTERVAL_MS;
  const pollTimeoutMs = polling.timeoutMs ?? POINTER_POLL_TIMEOUT_MS;

  /**
   * Wait for the case pointer to reach the revision we just proposed.
   *
   * A single read would be a race the job usually wins and occasionally
   * loses: `recoverSlowProjection` returns the moment the pathways wait gives
   * up, with the event durably written and the handler still running, so an
   * immediate read shows the OLD pointer for a proposal that lands seconds
   * later. Polling turns that into the non-event it is.
   */
  async function pointerReaches(
    caseId: string,
    revisionId: string,
  ): Promise<boolean> {
    const deadline = Date.now() + pollTimeoutMs;
    for (;;) {
      if ((await queue.getCurrentRevisionId(caseId)) === revisionId)
        return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async function sourceTextOf(
    candidate: ApplicabilityCandidateCase,
  ): Promise<string | null> {
    if (candidate.snapshotText) return candidate.snapshotText;
    if (!candidate.snapshotFragmentId) return null;
    const fragment = await usable.getFragmentById(
      candidate.snapshotFragmentId,
      env.LOGASAVN_WORKSPACE_ID,
    );
    // 404 — the fragment is GONE, and that is durable: the case has no text
    // to read, exactly like one that never had any. A malformed fragment
    // (present but contentless) IS transient, and throws.
    if (fragment === null) return null;
    if (!fragment.content) {
      throw new SourceUnreadableError(
        `fragment ${candidate.snapshotFragmentId} came back without content — retrying next run`,
      );
    }
    return bodyFromContent(fragment.content);
  }

  return async function runRegulationApplicabilityJob(
    _previous: JobState | undefined,
    args: { limit?: number; caseKeys?: string[]; dryRun?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const dryRun = args.dryRun ?? false;
    const candidates = await queue.listApplicabilityCandidates({
      limit: args.limit ?? 25,
      caseKeys: args.caseKeys,
    });

    context.reportProgress({
      phase: "extracting-applicability",
      message: `${candidates.length} cases without an applicability`,
      detailsTotal: candidates.length,
    });

    const proposed: ApplicabilityRunResult["proposed"] = [];
    const failed: ApplicabilityRunResult["failed"] = [];

    for (const [position, candidate] of candidates.entries()) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const named = { caseKey: candidate.caseKey, title: candidate.title };

      // Guarded per case: one unreachable fragment or one 429 must cost one
      // case, not the rest of the run.
      try {
        const text = await sourceTextOf(candidate);
        if (text === null) {
          failed.push({
            ...named,
            reason: "no_source_text",
            detail: candidate.snapshotFragmentId
              ? `source fragment ${candidate.snapshotFragmentId} is gone`
              : "case carries no source text to read",
          });
          continue;
        }

        const answer = await chat(
          buildApplicabilityMessages({
            title: candidate.title,
            jurisdiction: candidate.jurisdiction,
            text,
          }),
        );
        const extraction = parseApplicabilityAnswer(answer.text, text);
        if (extraction.kind === "failed") {
          failed.push({
            ...named,
            reason: extraction.reason,
            detail: extraction.detail,
          });
          continue;
        }

        if (dryRun) {
          proposed.push({ ...named, revisionId: null });
          continue;
        }

        const revisionId = randomUUID();
        // A revision event carries the COMPLETE resulting state, never a
        // delta: the base's fields with applicability replaced, and the
        // base's areas copied across untouched — an omitted area would land
        // as a deleted one.
        const written = await writer.writeRegulationRevisionProposedDetailed({
          revisionId,
          caseId: candidate.caseId,
          caseKey: candidate.caseKey,
          baseRevisionId: candidate.currentRevisionId,
          changes: [
            {
              field: "applicability",
              justification: justificationFor(extraction.applicability),
            },
          ],
          fields: {
            ...candidate.fields,
            applicability: extraction.applicability,
          },
          geometries: await queue.listRevisionGeometries(
            candidate.currentRevisionId,
          ),
          actor: APPLICABILITY_ACTOR,
          recordedAt: new Date().toISOString(),
        });

        // The projector DROPS a proposal whose base is no longer the current
        // revision (the edit-after-source-change race) — silently, by design,
        // because an event is a fact that must not throw on replay. Reading
        // the pointer back is how this job learns its proposal was refused,
        // instead of reporting a revision that does not exist.
        if (!(await pointerReaches(candidate.caseId, revisionId))) {
          // A pointer that has not moved is only a REFUSAL if the projection
          // finished. When the write came back through the slow-recovery path
          // the event is durable and its handler was still running, so the
          // honest report is "not landed yet, go look" — naming the revision
          // so an admin can.
          failed.push(
            written.projectionPending
              ? {
                  ...named,
                  reason: "projection_pending",
                  detail: `revision ${revisionId} is written but had not landed when the run ended — check the case`,
                }
              : {
                  ...named,
                  reason: "stale_base",
                  detail: `base revision ${candidate.currentRevisionId} was superseded before the proposal landed`,
                },
          );
          continue;
        }
        proposed.push({ ...named, revisionId });
      } catch (error) {
        failed.push({
          ...named,
          reason:
            error instanceof SourceUnreadableError
              ? "source_unreadable"
              : "chat_error",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        context.reportProgress({
          phase: "extracting-applicability",
          detailsProcessed: position + 1,
          detailsTotal: candidates.length,
        });
      }
    }

    const summary =
      `cases: ${candidates.length}, ` +
      `${dryRun ? "would propose" : "proposed"}: ${proposed.length}, ` +
      `failed: ${failed.length}${dryRun ? " (DRY RUN — nothing written)" : ""}`;
    const result: ApplicabilityRunResult = {
      summary,
      dryRun,
      proposed,
      failed,
    };

    console.info("[RegulationApplicability]", summary);
    for (const entry of failed) {
      console.info(
        "[RegulationApplicability]",
        `${entry.caseKey} — NOT PROPOSED (${entry.reason}): ${entry.detail ?? ""}`,
      );
    }

    return {
      checkedAt,
      changed: proposed.length > 0 && !dryRun,
      latestItems: [],
      // Structured on purpose: `message` is the only channel a run has to
      // whoever triggered it (it lands on the job state as
      // `progress.message`), and "which cases, and why not" is the whole
      // point of a backfill run. The human sentence rides along inside it.
      message: JSON.stringify(result),
    };
  };
}

/** §12 wants a reason per change. The machine's reason is what it read and
 * how much of it — the quotes themselves are in the proposal. */
function justificationFor(
  applicability: Parameters<typeof statedDimensionsOf>[0],
): string {
  const stated = statedDimensionsOf(applicability);
  const preamble =
    "extracted from the stored source text by the regulation-applicability job";
  if (stated.length === 0) {
    return `${preamble}; the source states no applicability, note attached for review`;
  }
  return `${preamble}; ${stated.length} dimension(s) stated (${stated.join(", ")}), quotes attached`;
}
