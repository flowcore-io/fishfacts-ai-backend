import { describe, expect, test } from "bun:test";
import {
  type PoiFragmentSource,
  PoiRepository,
} from "../../src/poi/repository";

const ENV = {
  USABLE_WORKSPACE_ID: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
  POI_FRAGMENT_TYPE_ID: "b816fad2-4918-46c1-80de-68a20e68f9ad",
};

const HANSTHOLM_FM = {
  key: "hanstholm_fyr",
  lat: 57.11269,
  lng: 8.59861,
  aliases: ["Hanstholm fyr", "Hanstholmen fyr"],
  source: "Danish register (Wikidata Q723232)",
};

function makeSource(overrides: Partial<PoiFragmentSource> = {}) {
  const calls = { list: 0, get: 0 };
  const source: PoiFragmentSource = {
    listFragments: async () => {
      calls.list += 1;
      return [{ id: "frag-1", title: "POI: Hanstholm fyr" }];
    },
    getFragmentById: async (id) => {
      calls.get += 1;
      return { id, title: "POI: Hanstholm fyr", frontmatter: HANSTHOLM_FM };
    },
    ...overrides,
  };
  return { source, calls };
}

describe("PoiRepository", () => {
  test("maps fragment frontmatter to gazetteer entries (detail fetch fills missing list frontmatter)", async () => {
    const { source, calls } = makeSource();
    const repo = new PoiRepository(source, ENV);
    const pois = await repo.list();
    expect(pois).toEqual([
      {
        key: "hanstholm_fyr",
        lat: 57.11269,
        lng: 8.59861,
        title: "Hanstholm fyr",
        aliases: ["Hanstholm fyr", "Hanstholmen fyr"],
        source: "Danish register (Wikidata Q723232)",
      },
    ]);
    expect(calls.get).toBe(1);
  });

  test("skips malformed and deleted (404 → null) fragments but keeps valid ones", async () => {
    const { source } = makeSource({
      listFragments: async () => [
        { id: "ok", title: "POI: Hanstholm fyr", frontmatter: HANSTHOLM_FM },
        { id: "bad-key", frontmatter: { ...HANSTHOLM_FM, key: "BAD KEY" } },
        { id: "bad-lat", frontmatter: { ...HANSTHOLM_FM, lat: 999 } },
        { id: "no-coords", frontmatter: { key: "somewhere_fyr" } },
        { id: "deleted-mid-refresh" },
      ],
      // null = the client saw a 404 (fragment deleted) — skipping is correct.
      getFragmentById: async () => null,
    });
    const pois = await new PoiRepository(source, ENV).list();
    expect(pois.map((p) => p.key)).toEqual(["hanstholm_fyr"]);
  });

  test("a transient detail-fetch failure fails the refresh instead of shrinking the snapshot", async () => {
    let nowMs = 0;
    let failDetail = false;
    const { source } = makeSource();
    const getOk = source.getFragmentById;
    source.getFragmentById = async (id, workspaceId) => {
      if (failDetail) throw new Error("Usable API HTTP 502: bad gateway");
      return getOk(id, workspaceId);
    };
    const repo = new PoiRepository(source, ENV, 1000, () => nowMs);

    const good = await repo.list();
    expect(good).toHaveLength(1);

    failDetail = true;
    nowMs = 1001; // TTL expired → refresh throws → complete snapshot survives
    expect(await repo.list()).toEqual(good);

    // With no snapshot at all the failure propagates (route answers 503).
    const emptyRepo = new PoiRepository(source, ENV, 1000, () => nowMs);
    await expect(emptyRepo.list()).rejects.toThrow("502");
  });

  test("caches within the TTL and refetches after it", async () => {
    let nowMs = 0;
    const { source, calls } = makeSource();
    const repo = new PoiRepository(source, ENV, 1000, () => nowMs);
    await repo.list();
    await repo.list();
    expect(calls.list).toBe(1);
    nowMs = 1001;
    await repo.list();
    expect(calls.list).toBe(2);
  });

  test("serves the last good snapshot when a refresh fails, throws when there is none", async () => {
    let nowMs = 0;
    let fail = false;
    const { source } = makeSource();
    const listOk = source.listFragments;
    source.listFragments = async (input) => {
      if (fail) throw new Error("usable down");
      return listOk(input);
    };
    const repo = new PoiRepository(source, ENV, 1000, () => nowMs);

    fail = true;
    await expect(repo.list()).rejects.toThrow("usable down");

    fail = false;
    const good = await repo.list();
    expect(good).toHaveLength(1);

    fail = true;
    nowMs = 1001; // TTL expired → refresh fails → stale snapshot served
    expect(await repo.list()).toEqual(good);
  });
});
