import { createHash } from "node:crypto";
import type { Env } from "@/env";
import { type GillnetVessel, fetchGillnetSnapshot } from "@/gillnet/scraper";
import type { PathwayWriter } from "@/pathways";
import type { JobExecutionResult, JobLatestItem, JobState } from "./types";

const FEED_URL = "https://ws.fve.fo/notification/GillnetPublic.aspx";

type Context = {
  signal: AbortSignal;
  isStopRequested: () => boolean;
  reportProgress: (progress: {
    phase: string;
    message?: string;
    itemsDiscovered?: number;
    detailsProcessed?: number;
    detailsTotal?: number;
  }) => void;
  checkpoint?: (
    update: (state: { job: JobState; updatedAt: string }) => void,
  ) => Promise<void>;
};

function signatureFor(snapshotDate: string, v: GillnetVessel): string {
  // The pathway uses `signature` as the idempotency key, so a same-day re-run
  // with identical nets is suppressed; a new snapshot (or moved nets) re-emits.
  return createHash("sha256")
    .update(
      JSON.stringify({
        callSign: v.callSign,
        snapshotDate,
        nets: v.nets.map((n) => [
          Math.round(n.from.lat * 1e5),
          Math.round(n.from.lng * 1e5),
          Math.round(n.to.lat * 1e5),
          Math.round(n.to.lng * 1e5),
        ]),
      }),
    )
    .digest("hex");
}

/**
 * 🇫🇴 Faroese gillnet positions collector. The Vørn GillnetPublic feed is a full
 * snapshot replaced ~once/day, so this fetches the whole active set and emits one
 * `gillnet.vessel.observed.0` event per vessel (region FO). The read model keeps
 * only the latest `snapshotDate`, so vessels that drop out fall away. A content
 * fingerprint over the snapshot makes the job a no-op when nothing changed.
 */
export function createGillnetPositionsJob(_env: Env, writer: PathwayWriter) {
  return async function runGillnetPositionsJob(
    previous: JobState | undefined,
    args: { refreshExisting?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    context.reportProgress({
      phase: "crawling-listings",
      message: "Fetching Vørn gillnet snapshot",
    });
    const snapshot = await fetchGillnetSnapshot(context.signal);
    const vessels = snapshot.vessels;
    context.reportProgress({
      phase: "filtering-known-fragments",
      message: `${vessels.length} vessels with gear (snapshot ${snapshot.snapshotDate})`,
      itemsDiscovered: vessels.length,
    });

    const fingerprint = createHash("sha256")
      .update(
        [snapshot.snapshotDate]
          .concat(vessels.map((v) => signatureFor(snapshot.snapshotDate, v)))
          .sort()
          .join("\n"),
      )
      .digest("hex");

    if (
      !args.refreshExisting &&
      previous?.lastRunStatus === "success" &&
      previous.listingFingerprint === fingerprint
    ) {
      return {
        checkedAt,
        changed: false,
        latestItems: previous.latestItems ?? [],
        message: `Gillnet snapshot ${snapshot.snapshotDate} unchanged (${vessels.length} vessels); no events emitted`,
      };
    }

    const latestItems: JobLatestItem[] = [];
    for (const v of vessels) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const signature = signatureFor(snapshot.snapshotDate, v);
      await writer.writeGillnetVesselObserved({
        callSign: v.callSign,
        vesselName: v.vesselName,
        gearType: v.gearType,
        snapshotDate: snapshot.snapshotDate,
        lastUpdatedAt: v.lastUpdatedAt,
        nets: v.nets.map((n) => ({
          idx: n.idx,
          from: { lat: n.from.lat, lon: n.from.lng, area: n.from.area ?? null },
          to: { lat: n.to.lat, lon: n.to.lng, area: n.to.area ?? null },
        })),
        signature,
        checkedAt,
      });
      latestItems.push({
        signature,
        title: `${v.vesselName} (${v.callSign}) — ${v.nets.length} nets`,
        url: FEED_URL,
        status: "current",
        jmNumber: v.callSign,
        lastCheckedAt: checkedAt,
      });
      context.reportProgress({
        phase: "emitting-events",
        message: `Emitted ${latestItems.length}/${vessels.length} gillnet vessels`,
        detailsProcessed: latestItems.length,
        detailsTotal: vessels.length,
      });
    }

    await context.checkpoint?.((state) => {
      state.job.listingFingerprint = fingerprint;
    });

    return {
      checkedAt,
      changed: true,
      latestItems: latestItems.slice(0, 25),
      message: `Emitted ${latestItems.length} Faroese gillnet vessels (snapshot ${snapshot.snapshotDate})`,
    };
  };
}
