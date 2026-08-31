import { FetchSource, PMTiles } from "pmtiles";
import {
  type HistoricChartLayer,
  getHistoricChartSheet,
} from "./historic-charts";

export class UnknownChartSheetError extends Error {
  constructor(public readonly sheet: string) {
    super(`unknown historic chart sheet: ${sheet}`);
  }
}

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

  private archiveFor(chart: HistoricChartLayer): PMTiles {
    const cached = this.archives.get(chart.sheet);
    if (cached) return cached;

    const url = `${this.assetsPublicBaseUrl}/api/v1/public/files/${chart.assetId}?download=false`;
    const archive = new PMTiles(new FetchSource(url));
    this.archives.set(chart.sheet, archive);
    return archive;
  }

  /** Returns null for a tile the archive does not cover, so the route can 204. */
  async getTile(
    sheet: string,
    z: number,
    x: number,
    y: number,
  ): Promise<Uint8Array | null> {
    const chart = getHistoricChartSheet(sheet);
    if (!chart) throw new UnknownChartSheetError(sheet);

    const tile = await this.archiveFor(chart).getZxy(z, x, y);
    if (!tile) return null;
    return new Uint8Array(tile.data);
  }
}
