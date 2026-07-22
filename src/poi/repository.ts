import type { Env } from "@/env";
import type { UsableFragment } from "@/usable/client";

/**
 * One Point-of-Interest gazetteer entry served by `GET /api/poi` — named
 * lighthouses/landmarks used as narrative boundary vertices in J-meldinger.
 * The FE's `draw_regulation_boundary` resolves landmark names against these
 * by exact key / exact alias (deterministic, never similarity search).
 */
export type PoiEntry = {
  key: string;
  lat: number;
  lng: number;
  title?: string;
  aliases?: string[];
  source?: string;
};

/** The slice of `UsableApiClient` the repository needs (narrow for tests). */
export type PoiFragmentSource = {
  listFragments(input: {
    workspaceId: string;
    fragmentTypeId: string;
    status?: string;
  }): Promise<UsableFragment[]>;
  getFragmentById(
    fragmentId: string,
    workspaceId: string,
  ): Promise<UsableFragment | null>;
};

const POI_KEY_RE = /^[a-z0-9_]+$/;

function toPoiEntry(fragment: UsableFragment): PoiEntry | null {
  const fm = fragment.frontmatter;
  if (!fm) return null;
  const { key, lat, lng, aliases, source } = fm;
  if (typeof key !== "string" || !POI_KEY_RE.test(key)) return null;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const cleanAliases = Array.isArray(aliases)
    ? aliases.filter((alias): alias is string => typeof alias === "string")
    : [];
  // POI fragment titles follow the "POI: <name>" convention — serve the name.
  const title = fragment.title?.replace(/^POI:\s*/, "");
  return {
    key,
    lat,
    lng,
    ...(title ? { title } : {}),
    ...(cleanAliases.length > 0 ? { aliases: cleanAliases } : {}),
    ...(typeof source === "string" && source ? { source } : {}),
  };
}

/**
 * Point-of-Interest gazetteer read model over the Usable POI fragments
 * (Fishfacts Knowledge workspace). The Usable list endpoint returns no
 * frontmatter, so each fragment is fetched for its structured coordinates;
 * malformed fragments are skipped so one bad edit can't take the gazetteer
 * down. Results are cached in-process with a short TTL (the store changes
 * rarely and the FE caches per session anyway), refreshes are single-flight,
 * and a failed refresh serves the last good snapshot rather than erroring.
 */
export class PoiRepository {
  private cache: { pois: PoiEntry[]; fetchedAt: number } | null = null;
  private inflight: Promise<PoiEntry[]> | null = null;

  constructor(
    private readonly usable: PoiFragmentSource,
    private readonly env: Pick<
      Env,
      "USABLE_WORKSPACE_ID" | "POI_FRAGMENT_TYPE_ID"
    >,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<PoiEntry[]> {
    if (this.cache && this.now() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.pois;
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    try {
      return await this.inflight;
    } catch (error) {
      // Stale beats down: the FE falls back to its 2 hardcoded entries on an
      // error response, which is worse than a slightly old gazetteer.
      if (this.cache) return this.cache.pois;
      throw error;
    }
  }

  private async refresh(): Promise<PoiEntry[]> {
    const fragments = await this.usable.listFragments({
      workspaceId: this.env.USABLE_WORKSPACE_ID,
      fragmentTypeId: this.env.POI_FRAGMENT_TYPE_ID,
      status: "active",
    });
    const pois: PoiEntry[] = [];
    for (const fragment of fragments) {
      const full = fragment.frontmatter
        ? fragment
        : await this.usable.getFragmentById(
            fragment.id,
            this.env.USABLE_WORKSPACE_ID,
          );
      const entry = full ? toPoiEntry(full) : null;
      if (entry) pois.push(entry);
    }
    this.cache = { pois, fetchedAt: this.now() };
    return pois;
  }
}
