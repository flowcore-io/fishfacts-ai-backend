import { randomUUID } from "node:crypto";
import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import type {
  PendingVerdictCase,
  RegulationQueueRepository,
} from "@/regulations/queue-repository";
import {
  buildVerdictMessages,
  parseVerdictAnswer,
} from "@/regulations/verdict";
import { type UsableFragment, bodyFromContent } from "@/usable/client";
import type { EmbedChatAnswer, EmbedChatMessage } from "@/usable/embed-chat";
import type { JobExecutionResult, JobState } from "./types";

/**
 * One stateless embed chat turn — a seam, so the job is tested against a fake
 * with no key, no network and no spend. The interesting failures are in what
 * we do with the answer.
 */
export type VerdictChat = (
  messages: EmbedChatMessage[],
) => Promise<EmbedChatAnswer>;

/** The slice of the Usable client this job needs, named so it can be faked. */
export type RegulationVerdictUsable = {
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

/**
 * 🧾 Structured verdicts for regulation cases awaiting one.
 *
 * For each case whose CURRENT revision has `verdict_status = 'pending'`, ask
 * the model (through the Usable Chat embed — the billing boundary) what about
 * this text cannot be trusted onto a chart without a human, and record the
 * answer as an event. The projection lands it on the revision and mirrors it
 * onto the case.
 *
 * Three outcomes per case, deliberately distinct:
 * - a schema-valid issue list → `status: "ok"` verdict event;
 * - an answer that is not a valid issue list, or a case with no source text
 *   at all → `status: "failed"` verdict event. The failure is a CASE STATE a
 *   human will see, not an exception;
 * - a transport error (the embed unreachable, a fragment fetch failing) → no
 *   event. That is not a fact about the text, and recording it as one would
 *   freeze a transient outage into the queue. The case stays pending and the
 *   next run retries it.
 *
 * Bounded by `limit` because each case costs an LLM call and the backlog on
 * first run is every case ever ingested — the job makes monotone progress
 * oldest-first instead of attempting the whole queue in one go.
 */
export function createRegulationVerdictJob(
  env: Env,
  writer: PathwayWriter,
  usable: RegulationVerdictUsable,
  queue: RegulationQueueRepository,
  chat: VerdictChat,
) {
  async function sourceTextOf(
    pending: PendingVerdictCase,
  ): Promise<string | null> {
    if (pending.snapshotText) return pending.snapshotText;
    if (!pending.snapshotFragmentId) return null;
    const fragment = await usable.getFragmentById(
      pending.snapshotFragmentId,
      env.LOGASAVN_WORKSPACE_ID,
    );
    if (fragment === null) {
      // 404 — the fragment is GONE, and that is durable: it earns a recorded
      // failed verdict a human will see, exactly like a case that never had
      // text. Throwing here would pin the case to the head of the oldest-first
      // queue as "transient" forever, burning a limit slot every run.
      return null;
    }
    if (!fragment.content) {
      // The fragment exists but came back malformed — that IS transient.
      throw new Error(
        `fragment ${pending.snapshotFragmentId} is unreadable — retrying next run`,
      );
    }
    return bodyFromContent(fragment.content);
  }

  return async function runRegulationVerdictJob(
    _previous: JobState | undefined,
    args: { limit?: number; caseKeys?: string[] },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    const pendingCases = await queue.listPendingVerdicts({
      limit: args.limit ?? 25,
      caseKeys: args.caseKeys,
    });

    context.reportProgress({
      phase: "judging-cases",
      message: `${pendingCases.length} cases awaiting a verdict`,
      detailsTotal: pendingCases.length,
    });

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    const lines: string[] = [];

    for (const [position, pending] of pendingCases.entries()) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }

      // Guarded per case: one unreachable fragment or one 429 must cost one
      // case, not the rest of the run.
      try {
        const text = await sourceTextOf(pending);
        let verdict: ReturnType<typeof parseVerdictAnswer>;
        let model: string | null = null;
        if (text === null) {
          // Structurally no text — a metadata-only announcement, or a corpus
          // fragment that no longer exists. Durable either way, so it earns a
          // recorded failure a human will see, not a retry loop.
          verdict = {
            status: "failed",
            error: pending.snapshotFragmentId
              ? `source fragment ${pending.snapshotFragmentId} is gone`
              : "case carries no source text to judge",
          };
        } else {
          const answer = await chat(
            buildVerdictMessages({
              title: pending.title,
              jurisdiction: pending.jurisdiction,
              text,
            }),
          );
          model = answer.model;
          verdict = parseVerdictAnswer(answer.text);
        }

        await writer.writeRegulationVerdictRecorded({
          verdictId: randomUUID(),
          caseKey: pending.caseKey,
          revisionId: pending.revisionId,
          contentHash: pending.contentHash,
          status: verdict.status,
          issues: verdict.status === "ok" ? verdict.issues : [],
          error: verdict.status === "failed" ? verdict.error : null,
          model,
          recordedAt: new Date().toISOString(),
        });

        if (verdict.status === "ok") {
          ok += 1;
          lines.push(
            `${pending.caseKey} — ${verdict.issues.length} issue(s): ${verdict.issues
              .map((issue) => issue.kind)
              .join(", ")}`,
          );
        } else {
          failed += 1;
          lines.push(`${pending.caseKey} — VERDICT FAILED: ${verdict.error}`);
        }
      } catch (error) {
        skipped += 1;
        const detail = error instanceof Error ? error.message : String(error);
        lines.push(`${pending.caseKey} — NOT JUDGED (will retry): ${detail}`);
      }

      context.reportProgress({
        phase: "judging-cases",
        detailsProcessed: position + 1,
        detailsTotal: pendingCases.length,
      });
    }

    const summary =
      `cases: ${pendingCases.length}, verdicts ok: ${ok}, ` +
      `verdicts failed (recorded): ${failed}, not judged (transient): ${skipped}`;
    console.info("[RegulationVerdict]", summary);
    for (const line of lines) console.info("[RegulationVerdict]", line);

    return {
      checkedAt,
      changed: ok + failed > 0,
      latestItems: [],
      message: summary,
    };
  };
}
