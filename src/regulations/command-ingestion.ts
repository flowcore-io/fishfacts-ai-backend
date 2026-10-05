import type { Env } from "@/env";
import { REGULATION_FLOW_TYPE } from "@/events/contracts";
import type { CommandPart } from "@/events/regulation-case-command";
import { CASE_COMMAND_PART_EVENT_TYPE } from "@/events/regulation-case-command";
import { SNAPSHOT_EVENT_BUDGET_BYTES } from "@/events/regulation-snapshot-parts";
/** Same installed transformer SDK webhook protocol, with abortable network
 * requests. Its writer has no network timeout option. No projection wait,
 * no core dependency upgrade, no automatic mutation retry with fresh IDs. */
export function createCommandIngestion(
  env: Pick<
    Env,
    | "FLOWCORE_API_URL"
    | "FLOWCORE_TENANT"
    | "FLOWCORE_DATA_CORE"
    | "FLOWCORE_API_KEY"
  >,
  send: typeof fetch = fetch,
  networkTimeoutMs = 10_000,
) {
  const ingest = async (
    eventType: string,
    payloads: readonly unknown[],
    flowType = REGULATION_FLOW_TYPE as string,
  ) => {
    if (
      !payloads.length ||
      payloads.length > 8 ||
      payloads.some(
        (p) =>
          Buffer.byteLength(JSON.stringify(p), "utf8") >
          SNAPSHOT_EVENT_BUDGET_BYTES,
      )
    )
      throw Error("ingestion batch resource limit");
    const batch = payloads.length > 1;
    const url = `${env.FLOWCORE_API_URL.replace(/\/$/, "")}/${batch ? "events" : "event"}/${[env.FLOWCORE_TENANT, env.FLOWCORE_DATA_CORE, flowType, eventType].map(encodeURIComponent).join("/")}`;
    const response = await send(url, {
      method: "POST",
      headers: {
        Authorization: env.FLOWCORE_API_KEY,
        "Content-Type": "application/json",
        "x-flowcore-metadata-json": Buffer.from(
          JSON.stringify({ source: "regulation-ordered-delivery" }),
        ).toString("base64"),
      },
      body: JSON.stringify(batch ? payloads : payloads[0]),
      signal: AbortSignal.timeout(networkTimeoutMs),
    });
    if (!response.ok)
      throw Error(
        `Flowcore ingestion outcome unconfirmed (${response.status})`,
      );
    const body = (await response.json()) as {
      eventId?: unknown;
      eventIds?: unknown;
      success?: boolean;
    };
    const ids = batch ? body.eventIds : [body.eventId];
    if (
      body.success === false ||
      !Array.isArray(ids) ||
      ids.length !== payloads.length ||
      ids.some((id) => typeof id !== "string" || !id.length)
    )
      throw Error("Flowcore ingestion receipt unconfirmed");
    return ids as string[];
  };
  return {
    ingest,
    emit: async (parts: readonly CommandPart[]) => {
      const eventIds: string[] = [];
      const deadline = Date.now() + 300_000;
      for (let i = 0; i < parts.length; i += 8) {
        if (Date.now() >= deadline)
          throw Error("command delivery outcome unconfirmed: deadline");
        eventIds.push(
          ...(await ingest(
            CASE_COMMAND_PART_EVENT_TYPE,
            parts.slice(i, i + 8),
          )),
        );
      }
      return { eventIds };
    },
  };
}
