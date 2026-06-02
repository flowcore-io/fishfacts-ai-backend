export type TileLayerKind = "polygon" | "line" | "point" | "point-heatmap";

export type TileLayer = {
  id: string;
  kind: TileLayerKind;
  description: string;
  attributes: readonly string[];
};

export const TILE_LAYERS: Record<string, TileLayer> = {
  "jmelding-closures": {
    id: "jmelding-closures",
    kind: "polygon",
    description:
      "Norwegian J-melding closure boundaries. v1 renders the convex hull of each closure's parsed vertices; future iterations will store true polygons.",
    attributes: ["jm_number", "title", "status"],
  },
};

export function listTileLayers(): TileLayer[] {
  return Object.values(TILE_LAYERS);
}

export function getTileLayer(id: string): TileLayer | null {
  return TILE_LAYERS[id] ?? null;
}
