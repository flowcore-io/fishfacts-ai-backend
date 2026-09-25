import {
  InternalPathwayState,
  type PathwayState,
  createPostgresPathwayState,
} from "@flowcore/pathways";
import type { Env } from "./env";

/**
 * How long an interactive write waits for its own projection before it
 * answers "recorded, still processing". Kept well inside the FE's 25 s
 * request budget (`REQUEST_TIMEOUT_MS`) so the route's pre-write lookups,
 * the webhook round-trip and the read-back all fit before the browser gives
 * up and reports `Status: 0` for a write that succeeded.
 */
export const INTERACTIVE_WRITE_WAIT_MS = 15_000;

const PROCESSED_POLL_INTERVAL_MS = 100;

/**
 * The pathway state a `pathways.write()` is awaited against, shared across
 * replicas.
 *
 * In cluster mode the handler runs on whichever pod the leader dispatches
 * the event to, while the awaiting request can sit on the other one. The
 * SDK's default `InternalPathwayState` is a per-process map, so that request
 * could never see the handler finish and always waited out the full timeout
 * (Flowcore Solution effc8b81). Processed markers therefore go to Postgres.
 *
 * Except for the high-volume fire-and-forget flows, which nobody waits on:
 * the AIS pump projects thousands of events per cycle, and a Postgres upsert
 * per event would tax exactly the throughput `AIS_PUMP_CONCURRENCY` is tuned
 * for. Those events are marked `markLocalOnly` just before their handler runs
 * and keep the in-process map. The default is the shared store, so a pathway
 * missing from the local-only list costs one upsert, never a stuck wait.
 */
export class SharedPathwayState implements PathwayState {
  private readonly localOnlyEventIds = new Set<string>();

  constructor(
    readonly shared: PathwayState,
    private readonly local: PathwayState = new InternalPathwayState(),
  ) {}

  markLocalOnly(eventId: string): void {
    this.localOnlyEventIds.add(eventId);
  }

  async setProcessed(eventId: string): Promise<void> {
    if (this.localOnlyEventIds.delete(eventId)) {
      await this.local.setProcessed(eventId);
      return;
    }
    await this.shared.setProcessed(eventId);
  }

  async isProcessed(eventId: string): Promise<boolean> {
    return (
      (await this.local.isProcessed(eventId)) ||
      (await this.shared.isProcessed(eventId))
    );
  }
}

export function createSharedPathwayState(
  env: Pick<Env, "DATABASE_URL">,
): SharedPathwayState {
  // Table `pathway_state` (SDK default), created lazily by the SDK and kept
  // out of drizzle by the `!pathway_*` tablesFilter.
  return new SharedPathwayState(
    createPostgresPathwayState({ connectionString: env.DATABASE_URL }),
  );
}

/**
 * Poll `isProcessed` until it is true or `timeoutMs` has passed — the same
 * loop the SDK runs after a non-fire-and-forget write, but with a deadline
 * the caller chooses. Resolves `false` on timeout instead of throwing: by
 * then the event is durably written, only its projection is unconfirmed.
 */
export async function awaitProcessed(
  state: Pick<PathwayState, "isProcessed">,
  eventId: string,
  timeoutMs: number,
  pollIntervalMs = PROCESSED_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await state.isProcessed(eventId))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return true;
}

/**
 * Write an event fire-and-forget, then wait for its projection within
 * `timeoutMs`. `projectionPending: true` means the write is durable and the
 * handler had not finished in time — a caller reading its own projection back
 * must not read the absence of its row as a refusal. Write failures (nothing
 * recorded) still throw.
 */
export async function awaitInteractiveWrite(
  label: string,
  state: Pick<PathwayState, "isProcessed">,
  doWrite: () => Promise<string | string[]>,
  timeoutMs: number = INTERACTIVE_WRITE_WAIT_MS,
): Promise<{ eventId: string; projectionPending: boolean }> {
  const written = await doWrite();
  const eventId = (Array.isArray(written) ? written[0] : written) as string;
  if (await awaitProcessed(state, eventId, timeoutMs)) {
    return { eventId, projectionPending: false };
  }
  console.warn(
    "[Pathways] write recorded but projection outran the wait — returning the pending event",
    { label, eventId, timeoutMs },
  );
  return { eventId, projectionPending: true };
}
