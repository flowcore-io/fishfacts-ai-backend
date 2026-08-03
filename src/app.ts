import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";
import { ZodError } from "zod";
import { requireAdmin } from "./auth/admin";
import type { TokenCache } from "./auth/cache";
import { createAuthMiddleware } from "./auth/middleware";
import "./auth/types";
import type { AisClickhouseRepository } from "./ais/clickhouse-repository";
import { isoToTimeBucket } from "./ais/flowcore-bucket-reader";
import type { AisIngestStateRepository } from "./ais/ingest-state-repository";
import { createAisRouter } from "./ais/routes";
import type { AisSource } from "./ais/types";
import type { AreasRepository } from "./areas/repository";
import { createAreasRouter } from "./areas/routes";
import type { Database } from "./db/client";
import { AIS_FLOW_TYPE } from "./events/contracts";
import { genericEventInputSchema } from "./events/contracts";
import type { GenericEventRepository } from "./events/repository";
import type { FinancialsRepository } from "./financials/repository";
import { createFinancialsRouter } from "./financials/routes";
import type { FishfactsApiClient } from "./fishfacts/client";
import type { GebcoRepository } from "./gebco/repository";
import type { GillnetRepository } from "./gillnet/repository";
import type { JMeldingGeoRepository } from "./jmelding/geo-repository";
import type { JobRunner } from "./jobs/runner";
import type { JobStateStore } from "./jobs/state-store";
import type { LogasavnReviewRepository } from "./logasavn/review-repository";
import { createLogasavnReviewRouter } from "./logasavn/routes";
import { openApiDocument } from "./openapi";
import type { PathwayRuntime } from "./pathways";
import type { PoiRepository } from "./poi/repository";
import { createPoiRouter } from "./poi/routes";
import type { ReportsClient } from "./reports/client";
import { createReportsRouter } from "./reports/routes";
import type { SildelagetCatchRepository } from "./sildelaget/repository";
import { createSildelagetCatchRouter } from "./sildelaget/routes";
import type { TilesRepository } from "./tiles/repository";
import { createTilesRouter } from "./tiles/routes";

export type AppDependencies = {
  repository: GenericEventRepository;
  pathways: PathwayRuntime;
  jobRunner: JobRunner;
  jobStateStore: JobStateStore;
  fishfactsClient: FishfactsApiClient;
  authCache: TokenCache;
  geoRepository: JMeldingGeoRepository;
  gillnetRepository: GillnetRepository;
  gebcoRepository: GebcoRepository;
  poiRepository: PoiRepository;
  logasavnReviewRepository: LogasavnReviewRepository;
  tilesRepository: TilesRepository;
  areasRepository: AreasRepository;
  sildelagetCatchRepository: SildelagetCatchRepository;
  financialsRepository: FinancialsRepository;
  aisRepository: AisClickhouseRepository;
  aisIngestState: AisIngestStateRepository;
  aisSource: AisSource;
  /** null = reports feature unconfigured (no REPORT_FRAGMENT_TYPE_ID). */
  reportsClient: ReportsClient | null;
  db: Database;
};

export function createApp({
  repository,
  pathways,
  jobRunner,
  jobStateStore,
  fishfactsClient,
  authCache,
  geoRepository,
  gillnetRepository,
  gebcoRepository,
  poiRepository,
  logasavnReviewRepository,
  tilesRepository,
  areasRepository,
  sildelagetCatchRepository,
  financialsRepository,
  aisRepository,
  aisIngestState,
  aisSource,
  reportsClient,
  db,
}: AppDependencies) {
  const app = new Hono();

  app.use("*", logger());
  app.use("*", timing());
  app.use("*", secureHeaders());
  app.use("*", cors());

  app.get("/", (c) => c.redirect("/docs"));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/openapi.json", (c) => c.json(openApiDocument));
  app.get("/api/docs", (c) => c.json(openApiDocument));
  app.get("/docs", (c) => c.html(renderApiReference()));
  app.get("/swagger", (c) => c.html(renderApiReference()));

  const authMiddleware = createAuthMiddleware(fishfactsClient, authCache);
  app.use("/api/events", authMiddleware);
  app.use("/api/events/*", authMiddleware);
  app.use("/api/jobs/*", authMiddleware);
  app.use("/api/jmeldinger", authMiddleware);
  app.use("/api/jmeldinger/*", authMiddleware);
  app.use("/api/tiles/*", authMiddleware);
  app.use("/api/areas", authMiddleware);
  app.use("/api/areas/*", authMiddleware);
  app.use("/api/catch", authMiddleware);
  app.use("/api/catch/*", authMiddleware);
  app.use("/api/financials", authMiddleware);
  app.use("/api/financials/*", authMiddleware);
  app.use("/api/ais/*", authMiddleware);
  app.use("/api/reports", authMiddleware);
  app.use("/api/reports/*", authMiddleware);

  app.route("/api/tiles", createTilesRouter({ tilesRepository }));
  app.route(
    "/api/areas",
    createAreasRouter({
      repository: areasRepository,
      writer: pathways.writer,
    }),
  );
  // NOTE: /api/poi is NOT auth-blanketed above — GET is public reference
  // data; the router applies authMiddleware + requireAdmin to the POST only.
  app.route(
    "/api/poi",
    createPoiRouter({
      repository: poiRepository,
      writer: pathways.writer,
      authMiddleware,
    }),
  );
  // ADMIN-only end to end: a pending row is an unverified reading of the law,
  // so unlike /api/poi there is no public read side here.
  app.route(
    "/api/logasavn/review",
    createLogasavnReviewRouter({
      repository: logasavnReviewRepository,
      authMiddleware,
    }),
  );
  app.route(
    "/api/catch",
    createSildelagetCatchRouter({ repository: sildelagetCatchRepository }),
  );
  app.route(
    "/api/financials",
    createFinancialsRouter({ repository: financialsRepository }),
  );
  app.route("/api/ais", createAisRouter({ repository: aisRepository }));
  // In-chat issue reports: POST open to any authenticated user (consented
  // session capture → Usable Report fragment); list/detail are ADMIN-only
  // proxies for the FE admin screen (Usable token never reaches the browser).
  app.route("/api/reports", createReportsRouter({ reports: reportsClient }));

  app.post("/api/events", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = genericEventInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", issues: parsed.error.issues },
        400,
      );
    }

    try {
      const eventId = await pathways.writer.writeGeneric(parsed.data);
      return c.json({ eventId }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "flowcore_write_failed", message }, 502);
    }
  });

  app.get("/api/events/:id", async (c) => {
    const event = await repository.findById(c.req.param("id"));
    if (!event) return c.json({ error: "not_found" }, 404);
    return c.json(event);
  });

  app.get("/api/jmeldinger", async (c) => {
    const url = new URL(c.req.url);
    const params = url.searchParams;
    const bboxParam = params.get("bbox");
    const nearParam = params.get("near");
    if (bboxParam && nearParam) {
      return c.json(
        {
          error: "invalid_query",
          message: "bbox and near are mutually exclusive",
        },
        400,
      );
    }
    const limit = parseLimit(params.get("limit"));
    const cursor = params.get("cursor");
    // Jurisdiction filter (NO/FO/IS). Norwegian J-meldinger + Faroese (Vørn) +
    // Icelandic (Fiskistofa) closures share this geo index.
    const regionRaw = params.get("region")?.trim().toUpperCase();
    const region =
      regionRaw === "NO" || regionRaw === "FO" || regionRaw === "IS"
        ? regionRaw
        : undefined;
    // Honoured on every path, spatial ones included — `status=current` means
    // "in force now" (see JMeldingGeoRepository › statusConditions), and a map
    // query is exactly where an expired closure would be drawn.
    const status = params.get("status") ?? undefined;
    // `asOf` lets "what is closed in March?" be SERVED rather than simulated.
    // The agent is unreliable at date maths and year boundaries, and the error
    // is directional — telling a skipper water is shut when it is legally open,
    // or the reverse. An unparseable value is rejected rather than silently
    // treated as now, which would answer a different question than was asked.
    const asOfRaw = params.get("asOf");
    const asOf = asOfRaw ? new Date(asOfRaw) : undefined;
    if (asOfRaw && Number.isNaN(asOf?.getTime())) {
      return c.json(
        { error: "invalid_asOf", message: "asOf must be an ISO 8601 instant" },
        400,
      );
    }

    // Bulk-draw path: return every matching regulation WITH geometry inline so
    // the client can draw a whole set (e.g. all Icelandic closures) in one call
    // instead of one get_regulation per area.
    if (params.get("includeAreas") === "true") {
      const drawBbox = bboxParam ? parseBbox(bboxParam) : undefined;
      if (bboxParam && !drawBbox)
        return c.json(
          {
            error: "invalid_bbox",
            message:
              "bbox must be minLon,minLat,maxLon,maxLat in [-180..180,-90..90]",
          },
          400,
        );
      const rows = await geoRepository.listForDrawing({
        region,
        status,
        bbox: drawBbox
          ? [drawBbox.minLon, drawBbox.minLat, drawBbox.maxLon, drawBbox.maxLat]
          : undefined,
        limit,
        asOf,
      });
      return c.json({
        rows,
        returned: rows.length,
        asOf: (asOf ?? new Date()).toISOString(),
      });
    }

    if (bboxParam) {
      const bbox = parseBbox(bboxParam);
      if (!bbox)
        return c.json(
          {
            error: "invalid_bbox",
            message:
              "bbox must be minLon,minLat,maxLon,maxLat in [-180..180,-90..90]",
          },
          400,
        );
      const page = await geoRepository.findInBbox({
        ...bbox,
        region,
        status,
        limit,
        cursor,
      });
      return c.json(page);
    }

    if (nearParam) {
      const near = parseNear(nearParam, params.get("radiusKm"));
      if (!near)
        return c.json(
          {
            error: "invalid_near",
            message:
              "near must be lon,lat with optional radiusKm 0..5000 (default 50)",
          },
          400,
        );
      const page = await geoRepository.findNear({
        ...near,
        region,
        status,
        limit,
        cursor,
      });
      return c.json(page);
    }

    const hasGeoRaw = params.get("hasGeo");
    const hasGeo =
      hasGeoRaw === null
        ? undefined
        : hasGeoRaw === "true"
          ? true
          : hasGeoRaw === "false"
            ? false
            : undefined;
    const q = params.get("q") ?? undefined;
    const page = await geoRepository.list({
      status,
      region,
      hasGeo,
      q,
      limit,
      cursor,
    });
    return c.json(page);
  });

  // Faroese gillnet positions (Vørn) — latest daily snapshot. Optional `bbox`
  // (minLon,minLat,maxLon,maxLat) to find nets near a trawl plan.
  app.get("/api/gillnet", async (c) => {
    const bboxParam = c.req.query("bbox");
    let bbox: [number, number, number, number] | undefined;
    if (bboxParam) {
      const parsed = parseBbox(bboxParam);
      if (!parsed)
        return c.json(
          {
            error: "invalid_bbox",
            message:
              "bbox must be minLon,minLat,maxLon,maxLat in [-180..180,-90..90]",
          },
          400,
        );
      bbox = [parsed.minLon, parsed.minLat, parsed.maxLon, parsed.maxLat];
    }
    const result = await gillnetRepository.listLatest({ bbox });
    return c.json(result);
  });

  // GEBCO undersea feature names (banks, ridges, basins, …). Public reference
  // gazetteer. `q` = name search, `bbox` = features in a map view, `near` =
  // point+radiusKm, `includeGeoJSON=true` adds geometry to name results.
  app.get("/api/gebco", async (c) => {
    const q = c.req.query("q");
    const bboxParam = c.req.query("bbox");
    const nearParam = c.req.query("near");
    const limit = parseLimit(c.req.query("limit") ?? null);
    const includeGeoJSON = c.req.query("includeGeoJSON") === "true";

    const set = [q, bboxParam, nearParam].filter(Boolean).length;
    if (set > 1) {
      return c.json(
        {
          error: "invalid_query",
          message: "pass at most one of q, bbox, near",
        },
        400,
      );
    }

    if (typeof q === "string" && q.trim().length > 0) {
      const features = await gebcoRepository.findByName(
        q,
        limit,
        includeGeoJSON,
      );
      return c.json({ query: { q }, features, returned: features.length });
    }
    if (bboxParam) {
      const parsed = parseBbox(bboxParam);
      if (!parsed)
        return c.json(
          {
            error: "invalid_bbox",
            message:
              "bbox must be minLon,minLat,maxLon,maxLat in [-180..180,-90..90]",
          },
          400,
        );
      const features = await gebcoRepository.findInBbox(
        [parsed.minLon, parsed.minLat, parsed.maxLon, parsed.maxLat],
        limit,
      );
      return c.json({
        query: { bbox: bboxParam },
        features,
        returned: features.length,
      });
    }
    if (nearParam) {
      const near = parseNear(nearParam, c.req.query("radiusKm") ?? null);
      if (!near)
        return c.json(
          {
            error: "invalid_near",
            message: "near must be lon,lat with radiusKm in (0..5000]",
          },
          400,
        );
      const features = await gebcoRepository.findNear(
        near.lon,
        near.lat,
        near.radiusKm,
        limit,
      );
      return c.json({
        query: { near: nearParam },
        features,
        returned: features.length,
      });
    }
    return c.json(
      {
        error: "invalid_query",
        message: "provide one of q, bbox, or near",
      },
      400,
    );
  });

  app.get("/api/gebco/:featureId", async (c) => {
    const feature = await gebcoRepository.findById(c.req.param("featureId"));
    if (!feature) return c.json({ error: "not_found" }, 404);
    return c.json(feature);
  });

  app.get("/api/jmeldinger/:jmNumber", async (c) => {
    const record = await geoRepository.findByJmNumber(c.req.param("jmNumber"));
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json(record);
  });

  app.post("/api/jobs/cron", requireAdmin, async (c) => {
    const results = await jobRunner.runAll("cron");
    return c.json(
      {
        ok: true,
        trigger: "cron",
        results,
        runAt: new Date().toISOString(),
      },
      202,
    );
  });

  app.post("/api/jobs/run", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
    if (jobId) {
      const started = await jobRunner.startJob(
        jobId,
        "manual",
        body.args ?? {},
      );
      void started.promise.catch((error) => {
        console.error("[Jobs] Manual run failed", {
          jobId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return c.json(
        {
          ok: true,
          mode: "single",
          jobId,
          runId: started.runId,
          state: started.state.job,
          runAt: new Date().toISOString(),
        },
        202,
      );
    }
    const results = await jobRunner.runAll("manual");
    return c.json({ ok: true, mode: "all", results }, 202);
  });

  app.get("/api/jobs/state", requireAdmin, async (c) => {
    const loaded = await jobStateStore.loadAll();
    return c.json({
      ok: true,
      jobs: jobRunner.definitions().map((job) => ({
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        defaultArgs: job.inputSchema.parse({}),
      })),
      runningJobIds: jobRunner.getRunningJobIds(),
      state: loaded.state,
      now: new Date().toISOString(),
    });
  });

  app.post("/api/jobs/stop", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.jobId !== "string" || !body.jobId) {
      return c.json({ ok: false, error: "jobId is required" }, 400);
    }
    const stopped = jobRunner.requestStop(body.jobId);
    return c.json({
      ok: true,
      jobId: body.jobId,
      message: stopped ? "Stop requested" : "No running job found",
    });
  });

  // --- AIS pipeline control ---
  // enable = start forward-fill (tail+pump from cutover T0) and pin the pump
  // cursor to T0 so it projects live immediately; resume = start/continue the
  // historical backfill (the supervisor picks it up within ~60s); pause = durable
  // stop of the backfill. The backfill self-projects history, so the pump only
  // ever handles the live tail.
  app.post("/api/ais/enable", requireAdmin, async (c) => {
    const now = new Date();
    const t0 = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        0,
        0,
        0,
      ),
    ).toISOString();
    const minEventTime = await aisSource.minEventTime();
    await aisIngestState.setControl({
      startAt: t0,
      backfillStartAt: minEventTime,
    });
    // Best-effort pump-cursor pin. A fresh flow may have no pump_state row yet;
    // re-run enable once the pump has initialized it (after the first live event).
    let pumpPinned = 0;
    try {
      const res = (await db.execute(
        sql`UPDATE pathway_pump_state SET time_bucket = ${isoToTimeBucket(t0)}, event_id = NULL WHERE flow_type = ${AIS_FLOW_TYPE}`,
      )) as unknown as { count?: number };
      pumpPinned = res?.count ?? 0;
    } catch (error) {
      console.error("[AIS] pump cursor pin failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return c.json({
      ok: true,
      cutover: t0,
      backfillStartAt: minEventTime,
      pumpPinned,
      message:
        "Forward-fill enabled (tail+pump from cutover). POST /api/ais/resume to start the historical backfill.",
    });
  });

  app.post("/api/ais/pause", requireAdmin, async (c) => {
    await aisIngestState.setControl({ backfillEnabled: false });
    const stopped = jobRunner.requestStop("ais-position-backfill");
    return c.json({
      ok: true,
      backfillEnabled: false,
      stoppedRunning: stopped,
    });
  });

  app.post("/api/ais/resume", requireAdmin, async (c) => {
    const control = await aisIngestState.getControl();
    if (!control.startAt || !control.backfillStartAt) {
      return c.json(
        { ok: false, error: "call POST /api/ais/enable first" },
        400,
      );
    }
    await aisIngestState.setControl({ backfillEnabled: true });
    return c.json({
      ok: true,
      backfillEnabled: true,
      message:
        "Backfill will (re)start within ~60s and resume from saved bucket state.",
    });
  });

  app.get("/api/ais/state", requireAdmin, async (c) => {
    const control = await aisIngestState.getControl();
    const buckets = await aisIngestState.countByStatus();
    const projection = await aisIngestState.countByProjectionStatus();
    let clickhouseRows: number | null = null;
    try {
      clickhouseRows = await aisRepository.totalRows();
    } catch {
      clickhouseRows = null;
    }
    const running = jobRunner.getRunningJobIds();
    return c.json({
      ok: true,
      control,
      buckets, // emit: MySQL → Flowcore
      projection, // CH refill: Flowcore → ClickHouse
      clickhouseRows,
      backfillRunning: running.includes("ais-position-backfill"),
      chRefillRunning: running.includes("ais-position-ch-refill"),
      now: new Date().toISOString(),
    });
  });

  app.post("/api/transformer", async (c) => {
    const body = await c.req.json();
    const secret = c.req.header("x-secret") ?? "";
    const result = await pathways.router.processEvent(body, secret);
    return c.json(result);
  });

  app.post("/reset", async (c) => {
    const body = await c.req.json();
    const secret = c.req.header("x-pump-reset-secret") ?? null;
    const result = await pathways.router.processReset(body, secret);
    return c.json(result);
  });

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return c.json({ error: "invalid_payload", issues: error.issues }, 400);
    }
    console.error(error);
    return c.json({ error: "internal_server_error" }, 500);
  });

  return app;
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 200);
}

function parseBbox(
  raw: string,
): { minLon: number; minLat: number; maxLon: number; maxLat: number } | null {
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts as [
    number,
    number,
    number,
    number,
  ];
  if (
    minLon < -180 ||
    minLon > 180 ||
    maxLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    minLat > 90 ||
    maxLat < -90 ||
    maxLat > 90 ||
    minLon > maxLon ||
    minLat > maxLat
  ) {
    return null;
  }
  return { minLon, minLat, maxLon, maxLat };
}

function parseNear(
  raw: string,
  radiusRaw: string | null,
): { lon: number; lat: number; radiusKm: number } | null {
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lon, lat] = parts as [number, number];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  const radiusKm = radiusRaw === null ? 50 : Number.parseFloat(radiusRaw);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 5000)
    return null;
  return { lon, lat, radiusKm };
}

function renderApiReference() {
  return `<!doctype html>
<html>
  <head>
    <title>Fishfacts AI Backend API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { margin: 0; }
    </style>
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/openapi.json"
      data-theme="purple"
      data-layout="modern"
      data-hide-dark-mode-toggle="true"
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
