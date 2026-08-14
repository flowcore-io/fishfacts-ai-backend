import type { Env } from "@/env";

/**
 * Vessel name / registration mark → FishFacts vessel id.
 *
 * Sildelaget reports name their vessel in words; AIS knows it only by
 * `location.vessel_id`. Something has to bridge the two before a report's
 * track can be looked up, and the FE does it against the vessel registry it
 * has already loaded. Server-side there is no user session to borrow from,
 * hence this port.
 */

/**
 * The registry list — PLURAL. `fetchVesselsAction` (fishfacts-fe
 * `src/store/vessel/vessels/vesselsActions.ts`) calls `ENDPOINTS.VESSELS`,
 * which is `/vessels` (`src/other/config.js`). The singular `/api/v3/vessel`
 * is NOT this list: FishFacts' own OpenAPI (`/v3/api-docs/api-v3`) declares no
 * GET on it at all, which is why calling it answers 500 with a valid session.
 *
 * The registry requires a token — verified live: 401 without, 200 with, 11 442
 * records.
 */
const VESSELS_PATH = "/api/v3/vessels";

/**
 * The outcome of a lookup. "not-found" and "unavailable" are deliberately
 * different answers: the first is knowledge about the vessel, the second is
 * the absence of knowledge about anything. Collapsing them is how a token
 * outage gets written into the read model as a permanent "no-vessel".
 */
export type VesselLookup =
  | { outcome: "resolved"; vesselId: number }
  /** The registry answered, and this vessel is not in it (or is ambiguous). */
  | { outcome: "not-found" }
  /** The registry could not be consulted — the caller must not conclude. */
  | { outcome: "unavailable"; reason: string };

export type VesselDirectory = {
  resolve(
    vesselName: string | null,
    registrationMark: string | null,
  ): Promise<VesselLookup>;
};

type VesselIndex = {
  byName: Map<string, number | null>;
  byRegistration: Map<string, number | null>;
  loadedAt: number;
};

/**
 * A registry entry, reduced to what we match on. NOTE THE RENAME ACROSS THE
 * SEAM: the Sildelaget report calls it `registrationMark`, the FishFacts
 * registry calls it `registrationNumber`. They are the same thing; reading
 * `registrationMark` off a registry record silently yields undefined and every
 * registration-based lookup misses. The registry's field is also NULLABLE
 * (observed null on live records), which is why empty keys are never indexed.
 */
type RegistryVessel = {
  id: number;
  name: string | null;
  registrationNumber: string | null;
};

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Reads the registry from `GET /api/v3/vessels` — the same list the FE holds
 * in `state.vessels` — and caches it in-process for
 * FISHFACTS_VESSEL_CACHE_TTL_MS. It is ~11.4k records that change on the scale
 * of weeks, and the anchor job asks it thousands of times an hour, so it is
 * fetched once per TTL (and once per burst: concurrent callers share the
 * in-flight request) rather than once per report.
 *
 * Response shape per FishFacts' OpenAPI (`DataResponseWrapperVesselResponse`):
 * `{ code, errors, message, data: VesselResponse[] }`, where a VesselResponse
 * carries `id`, `flag`, `name`, `vesselType` and `registrationNumber`.
 *
 * Every failure path — no token, HTTP error, timeout — returns "unavailable"
 * rather than "not-found", so a dependency being down can never be recorded
 * as a fact about a vessel.
 */
export class FishfactsVesselDirectory implements VesselDirectory {
  private index: VesselIndex | null = null;
  private loading: Promise<VesselIndex | { error: string }> | null = null;
  private warnedMissingToken = false;

  constructor(private readonly env: Env) {}

  async resolve(
    vesselName: string | null,
    registrationMark: string | null,
  ): Promise<VesselLookup> {
    const name = normalize(vesselName);
    const registration = normalize(registrationMark);
    // Nothing to match on. Terminal: no registry, however healthy, could ever
    // answer this report.
    if (!name && !registration) return { outcome: "not-found" };

    const loaded = await this.load();
    if ("error" in loaded) {
      return { outcome: "unavailable", reason: loaded.error };
    }

    // Name first, then the report's registration mark — the FE's precedence.
    // A key that maps to more than one vessel is stored as null (see
    // indexVessels): an arbitrary pick there would attach another vessel's
    // track to the report, which is exactly the failure the 150 km sanity flag
    // exists to catch. Measured on the live registry, that costs ~1.2% of
    // names, and a registration mark still resolves them.
    const byName = name ? loaded.byName.get(name) : undefined;
    if (typeof byName === "number") {
      return { outcome: "resolved", vesselId: byName };
    }
    const byRegistration = registration
      ? loaded.byRegistration.get(registration)
      : undefined;
    return typeof byRegistration === "number"
      ? { outcome: "resolved", vesselId: byRegistration }
      : { outcome: "not-found" };
  }

  private async load(): Promise<VesselIndex | { error: string }> {
    const fresh =
      this.index &&
      Date.now() - this.index.loadedAt < this.env.FISHFACTS_VESSEL_CACHE_TTL_MS;
    if (fresh && this.index) return this.index;
    if (this.loading) return this.loading;

    this.loading = this.fetchIndex()
      .then((result) => {
        if (!("error" in result)) {
          this.index = result;
          return result;
        }
        // A failed refresh keeps serving the previous index: a stale registry
        // resolves far more reports than an empty one, and the entries it
        // holds were true when it was read.
        return this.index ?? result;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async fetchIndex(): Promise<VesselIndex | { error: string }> {
    const token = this.env.FISHFACTS_SERVICE_TOKEN;
    if (!token) {
      if (!this.warnedMissingToken) {
        this.warnedMissingToken = true;
        console.warn(
          "[Vessels] FISHFACTS_SERVICE_TOKEN is unset — the registry cannot be read, so derived catch positions are SKIPPED (not stored as no-vessel)",
        );
      }
      return { error: "FISHFACTS_SERVICE_TOKEN is not configured" };
    }
    try {
      const response = await fetch(
        `${this.env.FISHFACTS_API_BASE_URL}${VESSELS_PATH}`,
        {
          headers: {
            accept: "application/json",
            "x-auth-token": token,
            // Required by the endpoint per FishFacts' OpenAPI.
            "X-Application": this.env.FISHFACTS_APPLICATION,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        console.error("[Vessels] registry fetch failed", {
          status: response.status,
        });
        return { error: `registry HTTP ${response.status}` };
      }
      const vessels = parseRegistry(await response.json());
      if (vessels.length === 0) {
        // An empty registry is far more likely to be an unexpected payload
        // shape than a fleet of none — treat it as no answer at all.
        return { error: "registry returned no vessels" };
      }
      const index = indexVessels(vessels);
      // ~11.4k vessels, ~1.2% of names ambiguous when this was measured.
      // Logged per load so the rate stays observable if it ever grows: every
      // ambiguous name is a report that can only be matched by registration.
      console.info("[Vessels] registry loaded", {
        vessels: vessels.length,
        names: index.byName.size,
        ambiguousNames: countAmbiguous(index.byName),
      });
      return index;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Vessels] registry fetch threw", { message });
      return { error: `registry request failed: ${message}` };
    }
  }
}

/**
 * `{ code, errors, message, data: VesselResponse[] }` → the fields we match
 * on. A bare array is accepted too, so a shape change upstream degrades to
 * "unavailable" rather than to silent mis-resolution.
 *
 * The whole registry is indexed, unfiltered. The FE narrows its copy by
 * `vesselType.supportedApps` for display, but only `id`, `flag`, `name`,
 * `vesselType` and `registrationNumber` have been observed on live records —
 * filtering on a field whose contents we have not seen risks silently
 * shrinking the registry, and the measured ambiguity rate (1.2% of names) is
 * for the unfiltered list anyway.
 */
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
      // Registry-side name for the report's `registrationMark`. Nullable.
      registrationNumber:
        typeof record.registrationNumber === "string"
          ? record.registrationNumber
          : null,
    });
  }
  return vessels;
}

function countAmbiguous(index: Map<string, number | null>): number {
  let count = 0;
  for (const id of index.values()) if (id === null) count += 1;
  return count;
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
