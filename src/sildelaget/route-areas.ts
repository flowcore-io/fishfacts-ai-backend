import type { SildelagetCatchEntryObserved } from "@/events/contracts";

export type SildelagetRouteCoordinate = {
  latitude: number;
  longitude: number;
};

export type SildelagetRouteArea = {
  routeKey: string;
  faoArea: string | null;
  centerLatitude: number | null;
  centerLongitude: number | null;
  coordinates: SildelagetRouteCoordinate[];
};

type SildelagetRouteAreaApiCoordinate = {
  Latitude?: unknown;
  Longitude?: unknown;
};

type SildelagetRouteAreaApiRecord = {
  Rute?: unknown;
  FAOArea?: unknown;
  Center?: SildelagetRouteAreaApiCoordinate;
  Coordinates?: SildelagetRouteAreaApiCoordinate[];
};

export async function fetchSildelagetRouteAreas(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<Map<string, SildelagetRouteArea>> {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "FishFactsJobs/1.0",
      accept: "application/json,*/*",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Sildelaget catch map areas HTTP ${response.status}`);
  }
  return parseSildelagetRouteAreas(await response.json());
}

export function parseSildelagetRouteAreas(
  payload: unknown,
): Map<string, SildelagetRouteArea> {
  const areas = new Map<string, SildelagetRouteArea>();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return areas;
  }
  for (const [key, rawValue] of Object.entries(payload)) {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      continue;
    }
    const value = rawValue as SildelagetRouteAreaApiRecord;
    const routeKey =
      normalizeSildelagetRouteKey(value.Rute) ??
      normalizeSildelagetRouteKey(key);
    if (!routeKey) continue;
    const centerLatitude = numberOrNull(value.Center?.Latitude);
    const centerLongitude = numberOrNull(value.Center?.Longitude);
    const coordinates = Array.isArray(value.Coordinates)
      ? value.Coordinates.map(toCoordinate).filter(
          (coord): coord is SildelagetRouteCoordinate => coord !== null,
        )
      : [];
    areas.set(routeKey, {
      routeKey,
      faoArea: stringOrNull(value.FAOArea),
      centerLatitude,
      centerLongitude,
      coordinates,
    });
  }
  return areas;
}

export function enrichSildelagetEntriesWithRouteAreas(
  entries: SildelagetCatchEntryObserved[],
  routeAreas: Map<string, SildelagetRouteArea>,
): SildelagetCatchEntryObserved[] {
  return entries.map((entry) => ({
    ...entry,
    lines: entry.lines.map((line) => {
      const routeKey = normalizeSildelagetRouteKey(line.route);
      const area = routeKey ? routeAreas.get(routeKey) : undefined;
      return {
        ...line,
        routeKey,
        routeFaoArea: area?.faoArea ?? null,
        routeCenterLatitude: area?.centerLatitude ?? null,
        routeCenterLongitude: area?.centerLongitude ?? null,
        routeCoordinates: area?.coordinates ?? null,
      };
    }),
  }));
}

export function collectSildelagetRouteKeys(
  entries: SildelagetCatchEntryObserved[],
): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const routeKey = normalizeSildelagetRouteKey(line.route);
      if (routeKey) keys.add(routeKey);
    }
  }
  return keys;
}

export function normalizeSildelagetRouteKey(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const digits = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return null;
  return `#${digits.padStart(4, "0")}`;
}

function toCoordinate(
  value: SildelagetRouteAreaApiCoordinate,
): SildelagetRouteCoordinate | null {
  const latitude = numberOrNull(value.Latitude);
  const longitude = numberOrNull(value.Longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
