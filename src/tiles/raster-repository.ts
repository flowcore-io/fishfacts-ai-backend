import { FetchSource, PMTiles } from "pmtiles";
import {
  type HistoricChartLayer,
  getHistoricChartLayer,
} from "./historic-charts";
import { UnknownTileLayerError } from "./repository";

/**
 * Serves pre-cut WebP raster tiles out of per-sheet PMTiles archives held in
 * Usable Assets.
 *
 * The archives are public, so no signature is minted per tile — Assets answers
 * range requests directly with `immutable` caching. A `PMTiles` instance keeps
 * the header and directory in memory after the first read, so a warm tile costs
 * a single range GET of just that tile's bytes rather than pulling the archive.
 */
export class RasterTilesRepository {
  private readonly archives = new Map<string, PMTiles>();

  constructor(private readonly assetsPublicBaseUrl: string) {}

  private archiveFor(layer: HistoricChartLayer): PMTiles {
    const cached = this.archives.get(layer.id);
    if (cached) return cached;

    const url = `${this.assetsPublicBaseUrl}/api/v1/public/files/${layer.assetId}?download=false`;
    const archive = new PMTiles(new FetchSource(url));
    this.archives.set(layer.id, archive);
    return archive;
  }

  /** Returns null for a tile the archive does not cover, so the route can 204. */
  async getTile(
    layerId: string,
    z: number,
    x: number,
    y: number,
  ): Promise<Uint8Array | null> {
    const layer = getHistoricChartLayer(layerId);
    if (!layer) throw new UnknownTileLayerError(layerId);

    const tile = await this.archiveFor(layer).getZxy(z, x, y);
    if (!tile) return null;
    return new Uint8Array(tile.data);
  }
}
