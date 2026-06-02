import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";
import { ZodError } from "zod";
import type { TokenCache } from "./auth/cache";
import { createAuthMiddleware } from "./auth/middleware";
import "./auth/types";
import type { AreasRepository } from "./areas/repository";
import { createAreasRouter } from "./areas/routes";
import { genericEventInputSchema } from "./events/contracts";
import type { GenericEventRepository } from "./events/repository";
import type { FishfactsApiClient } from "./fishfacts/client";
import type { JMeldingGeoRepository } from "./jmelding/geo-repository";
import type { JobRunner } from "./jobs/runner";
import type { JobStateStore } from "./jobs/state-store";
import { openApiDocument } from "./openapi";
import type { PathwayRuntime } from "./pathways";
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
  tilesRepository: TilesRepository;
  areasRepository: AreasRepository;
};

export function createApp({
  repository,
  pathways,
  jobRunner,
  jobStateStore,
  fishfactsClient,
  authCache,
  geoRepository,
  tilesRepository,
  areasRepository,
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

  app.route("/api/tiles", createTilesRouter({ tilesRepository }));
  app.route(
    "/api/areas",
    createAreasRouter({
      repository: areasRepository,
      writer: pathways.writer,
    }),
  );

  app.post("/api/events", async (c) => {
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
      const page = await geoRepository.findInBbox({ ...bbox, limit, cursor });
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
      const page = await geoRepository.findNear({ ...near, limit, cursor });
      return c.json(page);
    }

    const status = params.get("status") ?? undefined;
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
      hasGeo,
      q,
      limit,
      cursor,
    });
    return c.json(page);
  });

  app.get("/api/jmeldinger/:jmNumber", async (c) => {
    const record = await geoRepository.findByJmNumber(c.req.param("jmNumber"));
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json(record);
  });

  app.post("/api/jobs/cron", async (c) => {
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

  app.post("/api/jobs/run", async (c) => {
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

  app.get("/api/jobs/state", async (c) => {
    const loaded = await jobStateStore.loadAll();
    return c.json({
      ok: true,
      fragmentIds: loaded.fragmentIds,
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

  app.post("/api/jobs/stop", async (c) => {
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
