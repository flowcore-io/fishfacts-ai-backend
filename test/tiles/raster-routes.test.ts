import { describe, expect, test } from "bun:test";
import {
  HISTORIC_CHART_LAYERS,
  listHistoricChartLayers,
} from "../../src/tiles/historic-charts";
import type { RasterTilesRepository } from "../../src/tiles/raster-repository";
import type { TilesRepository } from "../../src/tiles/repository";
import { UnknownTileLayerError } from "../../src/tiles/repository";
import { createTilesRouter } from "../../src/tiles/routes";

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);

/** Vector side is not under test here; it just has to exist. */
const vectorRepository = {
  getTile: async () => new Uint8Array(0),
} as unknown as TilesRepository;

function makeApp(
  getTile: (
    layer: string,
    z: number,
    x: number,
    y: number,
  ) => Promise<Uint8Array | null>,
) {
  const rasterTilesRepository = { getTile } as unknown as RasterTilesRepository;
  return createTilesRouter({
    tilesRepository: vectorRepository,
    rasterTilesRepository,
  });
}

describe("raster chart tiles", () => {
  test("serves a webp tile with immutable caching", async () => {
    const app = makeApp(async () => WEBP);
    const res = await app.request("/historic-charts-559/10/525/301.webp");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);
  });

  test("passes the parsed coordinates through, without the extension", async () => {
    const seen: unknown[] = [];
    const app = makeApp(async (layer, z, x, y) => {
      seen.push([layer, z, x, y]);
      return WEBP;
    });
    await app.request("/historic-charts-560/8/132/58.webp");

    expect(seen).toEqual([["historic-charts-560", 8, 132, 58]]);
  });

  test("204s where the sheet does not cover the tile", async () => {
    const app = makeApp(async () => null);
    const res = await app.request("/historic-charts-559/10/1/1.webp");

    expect(res.status).toBe(204);
    // Absence is as durable as presence — a re-cut publishes a new archive.
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("404s an unknown layer", async () => {
    const app = makeApp(async (layer) => {
      throw new UnknownTileLayerError(layer);
    });
    const res = await app.request("/historic-charts-999/5/1/1.webp");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "unknown_layer",
      layer: "historic-charts-999",
    });
  });

  test("400s out-of-range zoom before touching the archive", async () => {
    let called = false;
    const app = makeApp(async () => {
      called = true;
      return WEBP;
    });
    const res = await app.request("/historic-charts-559/23/1/1.webp");

    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  test("500s a read failure without leaking a partial body", async () => {
    const app = makeApp(async () => {
      throw new Error("range request failed");
    });
    const res = await app.request("/historic-charts-559/10/525/301.webp");

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "tile_read_failed" });
  });

  test("catalog lists raster layers alongside the vector ones", async () => {
    const app = makeApp(async () => WEBP);
    const body = (await (await app.request("/catalog")).json()) as {
      layers: unknown[];
      rasterLayers: { id: string }[];
    };

    expect(Array.isArray(body.layers)).toBe(true);
    expect(body.rasterLayers.map((l) => l.id)).toContain("historic-charts-559");
  });
});

describe("historic chart catalog", () => {
  test("every sheet carries its CC BY attribution", () => {
    // Attribution is a licence condition, not decoration: a layer that reaches
    // the map without one puts us in breach.
    for (const layer of listHistoricChartLayers()) {
      expect(layer.attribution).toContain("Kartverket");
      expect(layer.attribution).toContain("CC BY 4.0");
    }
  });

  test("keys match their layer id, and asset ids are distinct", () => {
    const assetIds = new Set<string>();
    for (const [key, layer] of Object.entries(HISTORIC_CHART_LAYERS)) {
      expect(key).toBe(layer.id);
      expect(layer.id).toBe(`historic-charts-${layer.sheet}`);
      assetIds.add(layer.assetId);
    }
    expect(assetIds.size).toBe(Object.keys(HISTORIC_CHART_LAYERS).length);
  });

  test("bounds are ordered west,south,east,north", () => {
    for (const layer of listHistoricChartLayers()) {
      const [west, south, east, north] = layer.bounds;
      expect(west).toBeLessThan(east);
      expect(south).toBeLessThan(north);
    }
  });
});
