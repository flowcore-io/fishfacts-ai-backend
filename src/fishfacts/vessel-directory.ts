import type { Env } from "@/env";

/**
 * Vessel name / registration mark → FishFacts vessel id.
 *
 * Sildelaget reports name their vessel in words; AIS knows it only by
 * `location.vessel_id`. Something has to bridge the two before a report's
 * track can be looked up, and the FE does it against the vessel registry it
 * has already loaded. Server-side there is no user session to borrow from,
 * hence this port — and hence FISHFACTS_SERVICE_TOKEN.
 */
export type VesselDirectory = {
  resolve(
    vesselName: string | null,
    registrationMark: string | null,
  ): Promise<number | null>;
};

type VesselIndex = {
  byName: Map<string, number | null>;
  byRegistration: Map<string, number | null>;
  loadedAt: number;
};

type RegistryVessel = {
  id: number;
  name: string | null;
  registrationNumber: string | null;
};

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Reads the registry from `GET /api/v3/vessel` (the same list the FE holds in
 * `state.vessels`) with a service token, and caches it in-process for
 * FISHFACTS_VESSEL_CACHE_TTL_MS — the registry changes on the scale of weeks
 * and the anchor job asks it thousands of times an hour.
 *
 * Without FISHFACTS_SERVICE_TOKEN it resolves nothing, which surfaces as an
 * honest `no-vessel` on every report rather than a wrong position.
 */
export class FishfactsVesselDirectory implements VesselDirectory {
  private index: VesselIndex | null = null;
  private loading: Promise<VesselIndex | null> | null = null;
  private warnedMissingToken = false;

  constructor(private readonly env: Env) {}

  async resolve(
    vesselName: string | null,
    registrationMark: string | null,
  ): Promise<number | null> {
    const name = normalize(vesselName);
    const registration = normalize(registrationMark);
    if (!name && !registration) return null;

    const index = await this.load();
    if (!index) return null;

    // Name first, then registration mark — the FE's precedence. A key that
    // maps to more than one vessel is stored as null (see indexVessels): an
    // arbitrary pick there would attach another vessel's track to the report,
    // which is exactly the failure the 150 km sanity flag exists to catch.
    const byName = name ? index.byName.get(name) : undefined;
    if (typeof byName === "number") return byName;
    const byRegistration = registration
      ? index.byRegistration.get(registration)
      : undefined;
    return typeof byRegistration === "number" ? byRegistration : null;
  }

  private async load(): Promise<VesselIndex | null> {
    const fresh =
      this.index &&
      Date.now() - this.index.loadedAt < this.env.FISHFACTS_VESSEL_CACHE_TTL_MS;
    if (fresh) return this.index;
    if (this.loading) return this.loading;

    this.loading = this.fetchIndex()
      .then((index) => {
        if (index) this.index = index;
        // A failed refresh keeps serving the previous index: a stale registry
        // resolves far more reports than an empty one.
        return this.index;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async fetchIndex(): Promise<VesselIndex | null> {
    const token = this.env.FISHFACTS_SERVICE_TOKEN;
    if (!token) {
      if (!this.warnedMissingToken) {
        this.warnedMissingToken = true;
        console.warn(
          "[Vessels] FISHFACTS_SERVICE_TOKEN is unset — vessel resolution is disabled, derived catch positions will report status no-vessel",
        );
      }
      return null;
    }
    try {
      const response = await fetch(
        `${this.env.FISHFACTS_API_BASE_URL}/api/v3/vessel`,
        {
          headers: {
            accept: "application/json",
            "x-auth-token": token,
            "X-Application": this.env.FISHFACTS_APPLICATION,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        console.error("[Vessels] registry fetch failed", {
          status: response.status,
        });
        return null;
      }
      return indexVessels(parseRegistry(await response.json()));
    } catch (error) {
      console.error("[Vessels] registry fetch threw", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

/** A directory that resolves nothing — the default when no token is set. */
export const emptyVesselDirectory: VesselDirectory = {
  resolve: async () => null,
};

/** Accepts either a bare array or the `{ data: [...] }` FishFacts envelope. */
export function parseRegistry(payload: unknown): RegistryVessel[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : [];
  const vessels: RegistryVessel[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "number") continue;
    vessels.push({
      id: record.id,
      name: typeof record.name === "string" ? record.name : null,
      registrationNumber:
        typeof record.registrationNumber === "string"
          ? record.registrationNumber
          : null,
    });
  }
  return vessels;
}

/** Key → id, or → null when the key is ambiguous across several vessels. */
export function indexVessels(vessels: RegistryVessel[]): VesselIndex {
  const byName = new Map<string, number | null>();
  const byRegistration = new Map<string, number | null>();
  const add = (map: Map<string, number | null>, key: string, id: number) => {
    if (!key) return;
    const existing = map.get(key);
    if (existing === undefined) map.set(key, id);
    else if (existing !== id) map.set(key, null);
  };
  for (const vessel of vessels) {
    add(byName, normalize(vessel.name), vessel.id);
    add(byRegistration, normalize(vessel.registrationNumber), vessel.id);
  }
  return { byName, byRegistration, loadedAt: Date.now() };
}

/** Same normalisation the FE compares with: trimmed, lower-cased. */
function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
