/**
 * Faroese gillnet-position scraper (Vørn GillnetPublic feed). The feed informs
 * foreign trawlers where Faroese gillnets are set so they keep clear. It is a
 * full snapshot replaced ~once/day ("Last updated: DD-MM-YYYY HH:MM").
 *
 * Source: https://ws.fve.fo/notification/GillnetPublic.aspx — an ASP.NET page
 * whose data is an HTML table. Each vessel is a 4-cell header row
 * [gearType, vesselName, callSign, lastUpdated] followed by 7-cell net rows
 * [idx, fromLat, fromLon, fromArea, toLat, toLon, toArea]; a net is a from→to
 * line. Vessels with no active gear render a "No gear in wather..." row.
 *
 * Pure fetch+parse (no DB/event deps) so it is unit/live testable in isolation.
 */

const FEED_URL = "https://ws.fve.fo/notification/GillnetPublic.aspx";
const UA = "Mozilla/5.0 (compatible; FishFactsBot/1.0; +https://fishfacts.fo)";

export type GillnetPoint = { lat: number; lng: number; area?: string };
export type GillnetLine = { idx: number; from: GillnetPoint; to: GillnetPoint };

export type GillnetVessel = {
  callSign: string;
  vesselName: string;
  gearType: string;
  lastUpdatedAt?: string; // ISO; the vessel's own "last updated" stamp
  nets: GillnetLine[];
};

export type GillnetSnapshot = {
  /** Feed-level "Last updated" as an ISO date (the daily snapshot key). */
  snapshotDate: string;
  vessels: GillnetVessel[];
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** "62°46,7000' N" → 62.778333 ; "008°41,1000' W" → -8.685 */
export function parseDdm(raw: string): number | null {
  const m = raw.match(/(\d+)\s*°\s*([\d.,]+)\s*'?\s*([NSEWnsew])/);
  if (!m) return null;
  const deg = Number(m[1]);
  const min = Number(m[2].replace(",", "."));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  const hemi = m[3].toUpperCase();
  const val = deg + min / 60;
  return hemi === "S" || hemi === "W" ? -val : val;
}

const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/;

/** "19-06-2026 06:23" → ISO string (UTC). */
function parseFeedDate(raw: string): string | undefined {
  const m = raw.match(DATE_RE);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh, mi] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function rowCells(tr: string): string[] {
  return [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((m) => cellText(m[1]))
    .filter((c) => c.length > 0);
}

export function parseGillnetHtml(html: string): GillnetSnapshot {
  const updated = html.match(/Last updated:\s*([0-9: \-]+)/i)?.[1]?.trim();
  const snapshotDate =
    parseFeedDate(updated ?? "")?.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  const vessels: GillnetVessel[] = [];
  let current: GillnetVessel | null = null;
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = rowCells(m[1]);
    // Vessel header: [gearType, vesselName, callSign, "DD-MM-YYYY HH:MM"]
    if (cells.length === 4 && DATE_RE.test(cells[3])) {
      current = {
        gearType: cells[0],
        vesselName: cells[1],
        callSign: cells[2],
        lastUpdatedAt: parseFeedDate(cells[3]),
        nets: [],
      };
      vessels.push(current);
      continue;
    }
    // Net row: [idx, fromLat, fromLon, fromArea, toLat, toLon, toArea]
    if (current && cells.length === 7 && /^\d+\s*\.?$/.test(cells[0])) {
      const fromLat = parseDdm(cells[1]);
      const fromLng = parseDdm(cells[2]);
      const toLat = parseDdm(cells[4]);
      const toLng = parseDdm(cells[5]);
      if (
        fromLat != null &&
        fromLng != null &&
        toLat != null &&
        toLng != null
      ) {
        current.nets.push({
          idx: Number.parseInt(cells[0], 10),
          from: { lat: fromLat, lng: fromLng, area: cells[3] || undefined },
          to: { lat: toLat, lng: toLng, area: cells[6] || undefined },
        });
      }
    }
    // "No gear in wather..." rows leave the vessel with nets: [] (filtered below).
  }

  return {
    snapshotDate,
    vessels: vessels.filter((v) => v.nets.length > 0),
  };
}

export async function fetchGillnetSnapshot(
  signal?: AbortSignal,
): Promise<GillnetSnapshot> {
  const res = await fetch(FEED_URL, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal,
  });
  if (!res.ok) throw new Error(`Gillnet feed HTTP ${res.status}`);
  return parseGillnetHtml(await res.text());
}

/** [minLng, minLat, maxLng, maxLat] over all net endpoints, or null. */
export function gillnetBbox(
  nets: GillnetLine[],
): [number, number, number, number] | null {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const n of nets) {
    for (const p of [n.from, n.to]) {
      minLng = Math.min(minLng, p.lng);
      minLat = Math.min(minLat, p.lat);
      maxLng = Math.max(maxLng, p.lng);
      maxLat = Math.max(maxLat, p.lat);
    }
  }
  return Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
}
