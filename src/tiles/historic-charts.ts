/**
 * Kartverket "Fiskerikartserien" historic fishery charts, as raster tile layers.
 *
 * Each sheet is one PMTiles archive stored in Usable Assets and read with HTTP
 * range requests — see `RasterTilesRepository`. Nine objects rather than the
 * 13 183 loose tiles they contain, because Assets addresses assets by uuid and
 * has no `{z}/{x}/{y}` path form.
 *
 * `placementErrorKm` is how far the fitted georeference lands from the sheet's
 * own printed corner coordinates. It travels with the layer on purpose: the
 * Arctic sheets are mostly open water, where a graticule-crossing count has no
 * coastline to disambiguate it, and they need a human to place them rather than
 * another heuristic. Consumers should treat anything above a few km as not fit
 * to show without that pass.
 */

export type HistoricChartLayer = {
  id: string;
  sheet: string;
  year: number;
  /** Usable Assets file id of the PMTiles archive (public, range-readable). */
  assetId: string;
  description: string;
  /** Required by CC BY 4.0 — render this wherever the layer is drawn. */
  attribution: string;
  /** [west, south, east, north] from the sheet's fitted graticule. */
  bounds: [number, number, number, number];
  placementErrorKm: number;
};

export const HISTORIC_CHART_LAYERS: Record<string, HistoricChartLayer> = {
  "historic-charts-551": {
    id: "historic-charts-551",
    sheet: "551",
    year: 2007,
    assetId: "6f197ad0-fa5c-425d-9657-8b10cd43cadd",
    description: "Barentshavet — sydvestlige del",
    attribution:
      "Kartverket: Fiskerikart 551 — Barentshavet – sydvestlige del, 2007 — CC BY 4.0",
    bounds: [25, 68, 40, 74.5],
    placementErrorKm: 0.9,
  },
  "historic-charts-552": {
    id: "historic-charts-552",
    sheet: "552",
    year: 2001,
    assetId: "9013e8c4-0a4f-464e-bc1b-43e7eaf3e9a0",
    description: "Vesterålen — Vest-Finnmark — Bjørnøya",
    attribution:
      "Kartverket: Fiskerikart 552 — Vesterålen – Vest-Finnmark – Bjørnøya, 2001 — CC BY 4.0",
    bounds: [11, 68.1667, 26, 74.6667],
    placementErrorKm: 27.8,
  },
  "historic-charts-553": {
    id: "historic-charts-553",
    sheet: "553",
    year: 1965,
    assetId: "8f5fbea2-b5a4-4d64-82ca-e405b3f1f239",
    description: "Barentshavet — sydøstlige del",
    attribution:
      "Kartverket: Fiskerikart 553 — Barentshavet – sydøstlige del, 1965 — CC BY 4.0",
    bounds: [39, 68, 54, 74.5],
    placementErrorKm: 10.8,
  },
  "historic-charts-554": {
    id: "historic-charts-554",
    sheet: "554",
    year: 1965,
    assetId: "7a2e43ef-cd29-49d8-814a-ac48620e4346",
    description: "Bjørnøya — Vestspitsbergen",
    attribution:
      "Kartverket: Fiskerikart 554 — Bjørnøya – Vestspitsbergen, 1965 — CC BY 4.0",
    bounds: [11, 74.1667, 26, 78.8333],
    placementErrorKm: 78,
  },
  "historic-charts-555": {
    id: "historic-charts-555",
    sheet: "555",
    year: 1965,
    assetId: "a67817dc-5be4-45df-8037-99c67a1b1e5c",
    description: "Barentshavet — nordvestlige del",
    attribution:
      "Kartverket: Fiskerikart 555 — Barentshavet – nordvestlige del, 1965 — CC BY 4.0",
    bounds: [25, 74.3333, 40, 79],
    placementErrorKm: 25.6,
  },
  "historic-charts-557": {
    id: "historic-charts-557",
    sheet: "557",
    year: 1968,
    assetId: "4cb8490d-6d8c-4557-940f-bc8d45b3034e",
    description: "Haltenbanken — Vesterålen",
    attribution:
      "Kartverket: Fiskerikart 557 — Haltenbanken – Vesterålen, 1968 — CC BY 4.0",
    bounds: [5.83333, 64.5, 16.3333, 70],
    placementErrorKm: 1.1,
  },
  "historic-charts-558": {
    id: "historic-charts-558",
    sheet: "558",
    year: 2001,
    assetId: "eb6470bc-9895-4cf8-952f-7453fa62940f",
    description: "Vikingbanken — Haltenbanken",
    attribution:
      "Kartverket: Fiskerikart 558 — Vikingbanken – Haltenbanken, 2001 — CC BY 4.0",
    bounds: [-1.25, 60.5, 11, 65],
    placementErrorKm: 1,
  },
  "historic-charts-559": {
    id: "historic-charts-559",
    sheet: "559",
    year: 2005,
    assetId: "f9e29935-26c5-4457-bfbf-bda77b2b997f",
    description: "Nordsjøen — nordre blad",
    attribution:
      "Kartverket: Fiskerikart 559 — Nordsjøen – nordre blad, 2005 — CC BY 4.0",
    bounds: [-4.015, 56, 9.02, 60.8833],
    placementErrorKm: 1.4,
  },
  "historic-charts-560": {
    id: "historic-charts-560",
    sheet: "560",
    year: 1970,
    assetId: "e840fa10-0ffa-4a4a-81b5-6ea008391d22",
    description: "Nordsjøen — søndre blad",
    attribution:
      "Kartverket: Fiskerikart 560 — Nordsjøen – søndre blad, 1970 — CC BY 4.0",
    bounds: [-4.015, 51.0833, 9, 56.3333],
    placementErrorKm: 2.7,
  },
};

export function listHistoricChartLayers(): HistoricChartLayer[] {
  return Object.values(HISTORIC_CHART_LAYERS);
}

export function getHistoricChartLayer(id: string): HistoricChartLayer | null {
  return HISTORIC_CHART_LAYERS[id] ?? null;
}
