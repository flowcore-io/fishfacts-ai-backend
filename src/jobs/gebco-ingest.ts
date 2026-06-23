import { createHash } from "node:crypto";
import type { Env } from "@/env";
import { type GebcoFeature, fetchGebcoFeatures } from "@/gebco/ingester";
import type { PathwayWriter } from "@/pathways";
import type { JobExecutionResult, JobLatestItem, JobState } from "./types";

const SOURCE_URL = "https://www.gebco.net/data-products/undersea-feature-names";

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

function signatureFor(f: GebcoFeature): string {
  // `signature` is the pathway idempotency key — a re-run with identical
  // name/type/geometry is suppressed; an edited feature re-emits + upserts.
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: f.featureId,
        name: f.name,
        type: f.featureType,
        wkt: f.geomWkt,
      }),
    )
    .digest("hex");
}

/**
 * 🌊 GEBCO undersea feature names ingester. Pulls the full IHO-IOC gazetteer
 * from the public ArcGIS FeatureServer and emits one `gebco.feature.observed.0`
 * event per feature. Upsert-by-`feature_id` (no snapshot replace — the gazetteer
 * is append-mostly). A content fingerprint makes a re-run a no-op when GEBCO is
 * unchanged. Static reference data, so the job is manual/run-once (never
 * scheduled); re-trigger via `POST /api/jobs/run` when GEBCO republishes.
 */
export function createGebcoIngestJob(_env: Env, writer: PathwayWriter) {
  return async function runGebcoIngestJob(
    previous: JobState | undefined,
    args: { refreshExisting?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    context.reportProgress({
      phase: "crawling-listings",
      message: "Fetching GEBCO undersea features",
    });
    const features = await fetchGebcoFeatures(context.signal);
    context.reportProgress({
      phase: "filtering-known-fragments",
      message: `${features.length} undersea features fetched`,
      itemsDiscovered: features.length,
    });

    const fingerprint = createHash("sha256")
      .update(features.map(signatureFor).sort().join("\n"))
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
        message: `GEBCO unchanged (${features.length} features); no events emitted`,
      };
    }

    const latestItems: JobLatestItem[] = [];
    for (const f of features) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const signature = signatureFor(f);
      await writer.writeGebcoFeatureObserved({
        featureId: f.featureId,
        name: f.name,
        featureType: f.featureType,
        geometryType: f.geometryType,
        geomWkt: f.geomWkt,
        centroidLat: f.centroidLat,
        centroidLon: f.centroidLon,
        bbox: f.bbox,
        signature,
        checkedAt,
      });
      latestItems.push({
        signature,
        title: `${f.name} ${f.featureType}`,
        url: SOURCE_URL,
        status: "current",
        jmNumber: f.featureId,
        lastCheckedAt: checkedAt,
      });
      if (latestItems.length % 250 === 0) {
        context.reportProgress({
          phase: "emitting-events",
          message: `Emitted ${latestItems.length}/${features.length} features`,
          detailsProcessed: latestItems.length,
          detailsTotal: features.length,
        });
      }
    }

    await context.checkpoint?.((state) => {
      state.job.listingFingerprint = fingerprint;
    });

    return {
      checkedAt,
      changed: true,
      latestItems: latestItems.slice(0, 25),
      message: `Emitted ${latestItems.length} GEBCO undersea features`,
    };
  };
}
