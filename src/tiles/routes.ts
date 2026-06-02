import { Hono } from "hono";
import { listTileLayers } from "./catalog";
import { type TilesRepository, UnknownTileLayerError } from "./repository";

export type TilesRouterDeps = {
  tilesRepository: TilesRepository;
};

export function createTilesRouter({ tilesRepository }: TilesRouterDeps): Hono {
  const router = new Hono();

  router.get("/catalog", (c) => c.json({ layers: listTileLayers() }));

  router.get("/:layer/:z/:x/:y{.+\\.pbf}", async (c) => {
    const layer = c.req.param("layer");
    const z = Number.parseInt(c.req.param("z"), 10);
    const x = Number.parseInt(c.req.param("x"), 10);
    const yParam = c.req.param("y").replace(/\.pbf$/, "");
    const y = Number.parseInt(yParam, 10);

    if (
      !Number.isFinite(z) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      z < 0 ||
      z > 22
    ) {
      return c.json({ error: "invalid_tile_coords" }, 400);
    }

    try {
      const bytes = await tilesRepository.getTile(layer, z, x, y);
      if (bytes.byteLength === 0) {
        return c.body(null, 204, {
          "Cache-Control": "public, max-age=3600",
        });
      }
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        "Cache-Control": "public, max-age=3600",
      });
    } catch (err) {
      if (err instanceof UnknownTileLayerError) {
        return c.json({ error: "unknown_layer", layer: err.layerId }, 404);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "tile_generation_failed", message }, 500);
    }
  });

  return router;
}
