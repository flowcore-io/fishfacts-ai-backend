/**
 * Fiskeridirektoratet's own register of closed areas, as published geodata.
 *
 * Every closure we read out of a J-melding's prose, the authority also
 * publishes as a feature here, keyed by the same J-melding number and paragraph
 * — including `geom_original`, its vertex list in the statute's own
 * degrees-and-decimal-minutes notation. That is the thing our coordinate
 * grammar reconstructs from the text, so it is the comparison that can tell a
 * parser defect from a source defect.
 *
 * Two things the layer is NOT:
 *
 * - An archive. It carries closures in force, so a superseded amendment
 *   (J-144-2026, rolled up into J-153-2026) is simply absent. A J-melding with
 *   no features here has not necessarily diverged — it may just be historic.
 * - The drawable shape. `geom_original` is the statute's vertices; the polygon
 *   on the map is `geom_klippet`, clipped to the coastline, which for a fjord
 *   closure runs to six figures of vertices. Reading the clipped geometry is a
 *   separate job from checking that we read the statute correctly, and this
 *   module deliberately asks for neither (`returnGeometry=false`) — it keeps
 *   the whole register under a few tens of KB.
 */

const FISKERIDIR_CLOSURES_WFS =
  "https://gis.fiskeridir.no/server/rest/services/J_melding_stengt_wfs/MapServer/0/query";

const UA = "Mozilla/5.0 (compatible; FishFactsBot/1.0; +https://fishfacts.fo)";

export type OfficialVertex = { lat: number; lon: number };

export type OfficialClosure = {
  /** `jmelding_navn`, e.g. `J-153-2026`. */
  jmNumber: string;
  /** `paragraf` — the § the closure is defined in. */
  paragraph: number | null;
  name: string | null;
  /** Parsed `geom_original`, in the order the authority lists it. */
  vertices: OfficialVertex[];
  /** Entries of `geom_original` that did not parse, if any. */
  unreadableVertices: number;
};

type ArcGisFeature = {
  attributes: {
    jmelding_navn?: string | null;
    paragraf?: number | null;
    navn?: string | null;
    geom_original?: string | null;
  };
};

/**
 * Degrees and decimal minutes, in either of the two notations the register
 * actually uses:
 *
 *   `"70 45,000"`      → 70.75   (bare, comma decimal — the common form)
 *   `"010° 44.0000E"`  → 10.7333 (degree sign, hemisphere letter)
 *
 * Both appear inside `geom_original`, sometimes across paragraphs of the same
 * J-melding (J-146-2026 § 1 is the second form, § 2 the first).
 */
export function parseOfficialCoordinate(raw: string): number | null {
  const match =
    /^\s*(\d{1,3})\s*(?:°\s*)?(\d{1,3}(?:[.,]\d+)?)\s*(?:'\s*)?([NSEWVØ])?\s*$/i.exec(
      raw,
    );
  if (!match) return null;
  const degrees = Number(match[1]);
  const minutes = Number.parseFloat(match[2].replace(",", "."));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  if (minutes >= 60) return null;
  const hemisphere = match[3]?.toUpperCase();
  const sign =
    hemisphere === "S" || hemisphere === "W" || hemisphere === "V" ? -1 : 1;
  return sign * (degrees + minutes / 60);
}

export function parseOfficialVertices(raw: string | null | undefined): {
  vertices: OfficialVertex[];
  unreadable: number;
} {
  if (!raw) return { vertices: [], unreadable: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { vertices: [], unreadable: 0 };
  }
  if (!Array.isArray(parsed)) return { vertices: [], unreadable: 0 };
  const vertices: OfficialVertex[] = [];
  let unreadable = 0;
  for (const entry of parsed) {
    const lat =
      typeof entry?.lat === "string"
        ? parseOfficialCoordinate(entry.lat)
        : null;
    const lon =
      typeof entry?.lon === "string"
        ? parseOfficialCoordinate(entry.lon)
        : null;
    if (lat === null || lon === null) {
      unreadable++;
      continue;
    }
    vertices.push({ lat, lon });
  }
  return { vertices, unreadable };
}

export async function fetchFiskeridirClosures(
  signal?: AbortSignal,
): Promise<OfficialClosure[]> {
  const url = new URL(FISKERIDIR_CLOSURES_WFS);
  url.searchParams.set("where", "1=1");
  url.searchParams.set(
    "outFields",
    "jmelding_navn,paragraf,navn,geom_original",
  );
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  const response = await fetch(url, {
    headers: { "user-agent": UA },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Fiskeridirektoratet closure register returned ${response.status}`,
    );
  }
  const json = (await response.json()) as {
    features?: ArcGisFeature[];
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(
      `Fiskeridirektoratet closure register error: ${json.error.message ?? "unknown"}`,
    );
  }
  return (json.features ?? []).flatMap((feature) => {
    const jmNumber = feature.attributes.jmelding_navn?.trim();
    if (!jmNumber) return [];
    const { vertices, unreadable } = parseOfficialVertices(
      feature.attributes.geom_original,
    );
    return [
      {
        jmNumber,
        paragraph: feature.attributes.paragraf ?? null,
        name: feature.attributes.navn?.trim() ?? null,
        vertices,
        unreadableVertices: unreadable,
      },
    ];
  });
}
