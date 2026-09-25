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
 * Upper bound on remembered local-only event ids. An id normally leaves the
 * set at its `setProcessed`, but a handler that never returns (or a shutdown
 * mid-handler) would strand it; the oldest are evicted past this cap. Well
 * above the in-flight ceiling (AIS reserves 2000 per cycle), and an evicted
 * id only costs its marker one Postgres upsert.
 */
export const MAX_LOCAL_ONLY_EVENT_IDS = 20_000;

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
    if (this.localOnlyEventIds.size > MAX_LOCAL_ONLY_EVENT_IDS) {
      // A Set iterates in insertion order, so the first id is the oldest.
      const oldest = this.localOnlyEventIds.values().next().value;
      if (oldest !== undefined) this.localOnlyEventIds.delete(oldest);
    }
  }

  get localOnlyCount(): number {
    return this.localOnlyEventIds.size;
  }

  async setProcessed(eventId: string): Promise<void> {
    if (this.localOnlyEventIds.delete(eventId)) {
      await this.local.setProcessed(eventId);
      return;
    }
    await this.shared.setProcessed(eventId);
  }

  /**
   * Only ever polled by a waiting writer: the SDK (2.4.6) calls
   * `isProcessed` solely inside `waitForPathwayToBeProcessed`, never on the
   * delivery/handler path, and our own `awaitProcessed` is the other caller.
   * Fire-and-forget events are never waited on, so the Postgres fall-through
   * on a local miss costs nothing on the pump's hot path.
   */
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
  const eventId = Array.isArray(written) ? written[0] : written;
  if (!eventId) {
    throw new Error(
      `Pathway write "${label}" returned no event id — nothing to wait for`,
    );
  }
  // Past this line the event is durable. A failure while WAITING (the state
  // store erroring) says nothing about the write, so it is reported the same
  // way as a slow projection — never as a failed write a client would retry.
  let processed: boolean;
  try {
    processed = await awaitProcessed(state, eventId, timeoutMs);
  } catch (error) {
    console.warn(
      "[Pathways] write recorded but waiting for its projection failed — returning the pending event",
      {
        label,
        eventId,
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return { eventId, projectionPending: true };
  }
  if (processed) return { eventId, projectionPending: false };
  console.warn(
    "[Pathways] write recorded but projection outran the wait — returning the pending event",
    { label, eventId, timeoutMs },
  );
  return { eventId, projectionPending: true };
}

/**
 * Postgres codes for losing a concurrent `CREATE TABLE IF NOT EXISTS`: the
 * table's row type collides in `pg_type_typname_nsp_index` (23505), or the
 * relation appeared between the check and the create (42P07).
 */
const CREATE_RACE_CODES = new Set(["23505", "42P07"]);

function isCreateRace(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CREATE_RACE_CODES.has(code);
}

/**
 * Create the shared state's table at boot, before anything can race for it.
 * The SDK creates `pathway_state` lazily on first use and exposes no init
 * method, so two concurrent first uses — a writer's poll and a handler's
 * setProcessed, or two pods booting together — race its CREATE TABLE and
 * one of them fails (seen on the first write after the 2.13.1 deploy). A
 * probe read runs that initialisation once; losing the race is retried,
 * because by then the winner has created the table. Anything else throws.
 */
export async function ensurePathwayStateReady(
  state: Pick<PathwayState, "isProcessed">,
  {
    attempts = 3,
    backoffMs = 250,
  }: { attempts?: number; backoffMs?: number } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await state.isProcessed("startup-probe");
      return;
    } catch (error) {
      if (!isCreateRace(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}
