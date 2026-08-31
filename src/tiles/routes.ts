import { Hono } from "hono";
import { listTileLayers } from "./catalog";
import { listHistoricChartLayers } from "./historic-charts";
import type { RasterTilesRepository } from "./raster-repository";
import { type TilesRepository, UnknownTileLayerError } from "./repository";

export type TilesRouterDeps = {
  tilesRepository: TilesRepository;
  rasterTilesRepository: RasterTilesRepository;
};

// Vector tiles are generated per request from data that moves underneath them,
// so an hour. Raster chart tiles only change when a sheet is re-cut, and a
// re-cut publishes a new archive, so they can be cached hard.
const VECTOR_CACHE_CONTROL = "public, max-age=3600";
const RASTER_CACHE_CONTROL = "public, max-age=31536000, immutable";

function parseCoords(c: {
  req: { param: (k: string) => string };
}): { z: number; x: number; y: number } | null {
  const z = Number.parseInt(c.req.param("z"), 10);
  const x = Number.parseInt(c.req.param("x"), 10);
  const y = Number.parseInt(c.req.param("y").replace(/\.\w+$/, ""), 10);

  if (
    !Number.isFinite(z) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    z < 0 ||
    z > 22
  ) {
    return null;
  }
  return { z, x, y };
}

export function createTilesRouter({
  tilesRepository,
  rasterTilesRepository,
}: TilesRouterDeps): Hono {
  const router = new Hono();

  router.get("/catalog", (c) =>
    c.json({
      layers: listTileLayers(),
      rasterLayers: listHistoricChartLayers(),
    }),
  );

  router.get("/:layer/:z/:x/:y{.+\\.pbf}", async (c) => {
    const layer = c.req.param("layer");
    const coords = parseCoords(c);
    if (!coords) {
      return c.json({ error: "invalid_tile_coords" }, 400);
    }

    try {
      const bytes = await tilesRepository.getTile(
        layer,
        coords.z,
        coords.x,
        coords.y,
      );
      if (bytes.byteLength === 0) {
        return c.body(null, 204, { "Cache-Control": VECTOR_CACHE_CONTROL });
      }
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        "Cache-Control": VECTOR_CACHE_CONTROL,
      });
    } catch (err) {
      if (err instanceof UnknownTileLayerError) {
        return c.json({ error: "unknown_layer", layer: err.layerId }, 404);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "tile_generation_failed", message }, 500);
    }
  });

  router.get("/:layer/:z/:x/:y{.+\\.webp}", async (c) => {
    const layer = c.req.param("layer");
    const coords = parseCoords(c);
    if (!coords) {
      return c.json({ error: "invalid_tile_coords" }, 400);
    }

    try {
      const bytes = await rasterTilesRepository.getTile(
        layer,
        coords.z,
        coords.x,
        coords.y,
      );
      // Sheets are rectangles on a globe: most of a covering tile range falls
      // outside the scan, and 204 is what a raster source expects there.
      if (!bytes) {
        return c.body(null, 204, { "Cache-Control": RASTER_CACHE_CONTROL });
      }
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "image/webp",
        "Cache-Control": RASTER_CACHE_CONTROL,
      });
    } catch (err) {
      if (err instanceof UnknownTileLayerError) {
        return c.json({ error: "unknown_layer", layer: err.layerId }, 404);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "tile_read_failed", message }, 500);
    }
  });

  return router;
}
