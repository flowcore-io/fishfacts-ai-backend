import { createHash } from "node:crypto";
import type { ClosureRecord } from "@/closures/scrapers";
import { FISKISTOFA_LAYERS, fetchFiskistofaLayer } from "@/closures/scrapers";
import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import type { JobExecutionResult, JobLatestItem, JobState } from "./types";

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

type ClosurePoint = ClosureRecord["points"][number];

// Cap on the MERGED multi-part point set per closure (the per-feature scraper
// cap is separate); keeps the emitted event under Flowcore's 64 KB limit.
const MERGED_MAX_POINTS = 600;

function decimatePoints(points: ClosurePoint[], max: number): ClosurePoint[] {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: ClosurePoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

function bboxOfPoints(
  points: ClosurePoint[],
): [number, number, number, number] | undefined {
  if (points.length === 0) return undefined;
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minLng = Math.min(minLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLng = Math.max(maxLng, p.lng);
    maxLat = Math.max(maxLat, p.lat);
  }
  return [minLng, minLat, maxLng, maxLat];
}

function toAnnouncementStatus(
  status: ClosureRecord["status"],
): JobLatestItem["status"] {
  if (status === "active") return "current";
  if (status === "archived") return "archived";
  return "unknown";
}

function signatureFor(record: ClosureRecord): string {
  // The pathway treats `signature` as the idempotency key — a re-emit with an
  // unchanged signature is suppressed. Include every projected field that can
  // change (title, status, validity, geometry) so corrections re-deliver.
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceKey: record.sourceKey,
        title: record.title,
        status: record.status,
        validFrom: record.validFrom ?? "",
        validTo: record.validTo ?? "",
        bbox: record.bbox ?? null,
        points: record.points.map((p) => [
          Math.round(p.lat * 1e5),
          Math.round(p.lng * 1e5),
        ]),
      }),
    )
    .digest("hex");
}

/**
 * 🇮🇸 Fiskistofa closures collector. The public GeoServer WFS only serves the
 * CURRENTLY-ACTIVE closures (the `virk*`/`virkar*` layers), so fetching every
 * active feature each run IS the minimal incremental scrape — there is no
 * growing historical archive to page through. Placeholder features (no
 * geometry) are dropped. A content fingerprint over the whole active set makes
 * the job a no-op when nothing changed; otherwise it re-emits the active set
 * onto the shared J-melding announcement pathway with `region: "IS"` +
 * pre-parsed geometry (idempotent upsert keyed by sourceKey), landing them in
 * the same geo store + `search_regulations`/`get_regulation` surface.
 */
export function createFiskistofaWfsClosuresJob(
  _env: Env,
  writer: PathwayWriter,
) {
  return async function runFiskistofaWfsClosuresJob(
    previous: JobState | undefined,
    args: { refreshExisting?: boolean },
    context: Context,
  ): Promise<JobExecutionResult> {
    const checkedAt = new Date().toISOString();
    context.reportProgress({
      phase: "crawling-listings",
      message: `Fetching ${FISKISTOFA_LAYERS.length} Fiskistofa WFS layers`,
    });

    // A single closure (one stable attribute id) is sometimes split into
    // several WFS features (multi-part geometry — e.g. "963 gr. 27 bb" ×3).
    // MERGE parts sharing a sourceKey into one record so we (a) dedupe to one
    // row/fragment per closure and (b) keep ALL the geometry instead of letting
    // the last part overwrite the others.
    const byKey = new Map<string, ClosureRecord>();
    for (const { layer, closureType } of FISKISTOFA_LAYERS) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      const records = await fetchFiskistofaLayer(layer, closureType).catch(
        () => [] as ClosureRecord[],
      );
      for (const record of records) {
        // Drop placeholder/empty features — only geometry-bearing closures.
        if (record.points.length === 0 || record.geometryType === "none") {
          continue;
        }
        const existing = byKey.get(record.sourceKey);
        if (existing) {
          existing.points.push(...record.points);
        } else {
          byKey.set(record.sourceKey, {
            ...record,
            points: [...record.points],
          });
        }
      }
    }

    // Recompute bbox over the merged point set + cap total points (the merged
    // set can exceed the 64 KB event limit across many parts).
    const records = Array.from(byKey.values()).map((r) => {
      const points = decimatePoints(r.points, MERGED_MAX_POINTS);
      return { ...r, points, bbox: bboxOfPoints(points) };
    });
    context.reportProgress({
      phase: "filtering-known-fragments",
      message: `${records.length} active Fiskistofa closures with geometry`,
      itemsDiscovered: records.length,
    });

    const fingerprint = createHash("sha256")
      .update(
        records
          .map((r) => `${r.sourceKey}:${signatureFor(r)}`)
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
        message: `Active Fiskistofa closure set unchanged (${records.length} closures); no events emitted`,
      };
    }

    if (records.length === 0) {
      await context.checkpoint?.((state) => {
        state.job.listingFingerprint = fingerprint;
      });
      return {
        checkedAt,
        changed: previous?.listingFingerprint !== fingerprint,
        latestItems: [],
        message: "No active Fiskistofa closures with geometry found",
      };
    }

    const latestItems: JobLatestItem[] = [];
    for (const record of records) {
      if (context.signal.aborted || context.isStopRequested()) {
        throw new Error("Job stopped by request");
      }
      await writer.writeJMeldingAnnouncement({
        signature: signatureFor(record),
        title: record.title,
        url: record.url ?? "",
        status: toAnnouncementStatus(record.status),
        jmNumber: record.sourceKey,
        validFrom: record.validFrom,
        validTo: record.validTo,
        category: record.closureType,
        region: "IS",
        areas: [
          {
            name: record.title,
            points: record.points.map((p) => ({ lat: p.lat, lon: p.lng })),
          },
        ],
        bodyMarkdown: record.bodyMarkdown,
        checkedAt,
      });
      latestItems.push({
        signature: signatureFor(record),
        title: record.title,
        url: record.url ?? "",
        status: toAnnouncementStatus(record.status),
        jmNumber: record.sourceKey,
        validFrom: record.validFrom,
        validTo: record.validTo,
        category: record.closureType,
        lastCheckedAt: checkedAt,
      });
      context.reportProgress({
        phase: "emitting-events",
        message: `Emitted ${latestItems.length}/${records.length} Fiskistofa closures`,
        detailsProcessed: latestItems.length,
        detailsTotal: records.length,
      });
    }

    await context.checkpoint?.((state) => {
      state.job.listingFingerprint = fingerprint;
    });

    return {
      checkedAt,
      changed: true,
      latestItems: latestItems.slice(0, 25),
      message: `Emitted ${latestItems.length} active Fiskistofa closures (region IS)`,
    };
  };
}
