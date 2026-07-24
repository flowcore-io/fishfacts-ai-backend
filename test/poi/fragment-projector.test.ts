import { describe, expect, test } from "bun:test";
import type { PoiCreated } from "../../src/events/contracts";
import {
  PoiFragmentProjector,
  type PoiFragmentSink,
} from "../../src/poi/fragment-projector";
import type { UsableFragment } from "../../src/usable/client";
import { frontmatterFromContent } from "../../src/usable/client";

const ENV = {
  USABLE_WORKSPACE_ID: "d72eb385-f9cf-43ec-bca5-cc80432877f8",
  POI_FRAGMENT_TYPE_ID: "b816fad2-4918-46c1-80de-68a20e68f9ad",
};

const POI: PoiCreated = {
  key: "skarvenes_lykt",
  title: "Skarvenes lykt (minor light, Finnmark)",
  lat: 70.9012,
  lng: 26.7345,
  aliases: ["Skarvenes lykt", "Skarvenes light"],
  source: 'NGA List of Lights 115-5678, supplied by admin "gilli" in chat',
  verifiedBy: "gilli",
  verifiedAt: "2026-07-24T10:00:00.000Z",
};

type SinkCalls = {
  getByKey: Array<{ workspaceId: string; key: string }>;
  create: Array<Parameters<PoiFragmentSink["createFragment"]>[0]>;
  update: Array<{
    fragmentId: string;
    input: Parameters<PoiFragmentSink["updateFragment"]>[1];
  }>;
};

function makeSink(opts: {
  existing?: UsableFragment | null;
  createError?: Error;
}) {
  const calls: SinkCalls = { getByKey: [], create: [], update: [] };
  const sink: PoiFragmentSink = {
    getFragmentByKey: async (workspaceId, key) => {
      calls.getByKey.push({ workspaceId, key });
      return opts.existing ?? null;
    },
    createFragment: async (input) => {
      if (opts.createError) throw opts.createError;
      calls.create.push(input);
      return { id: "frag-new", title: input.title };
    },
    updateFragment: async (fragmentId, input) => {
      calls.update.push({ fragmentId, input });
      return { id: fragmentId, title: input.title };
    },
  };
  return { sink, calls };
}

describe("PoiFragmentProjector", () => {
  test("creates a new fragment whose content round-trips through the REST frontmatter parser", async () => {
    const { sink, calls } = makeSink({ existing: null });
    let invalidated = 0;
    const projector = new PoiFragmentProjector(ENV, sink, () => {
      invalidated += 1;
    });

    const result = await projector.project(POI);

    expect(result.mode).toBe("created");
    expect(calls.create).toHaveLength(1);
    const created = calls.create[0];
    expect(created.workspaceId).toBe(ENV.USABLE_WORKSPACE_ID);
    expect(created.fragmentTypeId).toBe(ENV.POI_FRAGMENT_TYPE_ID);
    expect(created.key).toBe("skarvenes_lykt");
    // Read side strips the "POI: " prefix back off (PoiRepository.toPoiEntry).
    expect(created.title).toBe("POI: Skarvenes lykt (minor light, Finnmark)");

    // The load-bearing wiring: Usable's REST API serves frontmatter only as
    // the YAML block inside `content` (solution 4e7e9e61) — the read model
    // must be able to parse this exact content back into a gazetteer entry.
    const fm = frontmatterFromContent(created.content);
    expect(fm).toMatchObject({
      kind: "point-of-interest",
      key: "skarvenes_lykt",
      lat: 70.9012,
      lng: 26.7345,
      aliases: ["Skarvenes lykt", "Skarvenes light"],
      source: POI.source,
      verifiedBy: "gilli",
      verifiedAt: "2026-07-24T10:00:00.000Z",
    });

    expect(invalidated).toBe(1);
  });

  test("an existing fragment with the key is updated, not duplicated", async () => {
    const { sink, calls } = makeSink({
      existing: { id: "frag-existing", title: "POI: Skarvenes lykt (old)" },
    });
    const projector = new PoiFragmentProjector(ENV, sink);

    const result = await projector.project(POI);

    expect(result).toMatchObject({
      mode: "updated",
      fragmentId: "frag-existing",
    });
    expect(calls.create).toHaveLength(0);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].fragmentId).toBe("frag-existing");
    const fm = frontmatterFromContent(calls.update[0].input.content ?? "");
    expect(fm).toMatchObject({ key: "skarvenes_lykt", lat: 70.9012 });
  });

  test("a 409 create race falls back to updating the winner", async () => {
    let raceSettled = false;
    const { sink, calls } = makeSink({
      createError: new Error("Usable API HTTP 409: duplicate key"),
    });
    const innerGet = sink.getFragmentByKey;
    sink.getFragmentByKey = async (workspaceId, key) => {
      if (raceSettled) return { id: "frag-winner", title: "POI: winner" };
      raceSettled = true; // first read (pre-create) sees no fragment
      return innerGet(workspaceId, key);
    };
    const projector = new PoiFragmentProjector(ENV, sink);

    const result = await projector.project(POI);

    expect(result).toMatchObject({
      mode: "updated",
      fragmentId: "frag-winner",
    });
    expect(calls.update).toHaveLength(1);
  });

  test("a failed write neither swallows the error nor invalidates the read cache", async () => {
    const { sink } = makeSink({
      createError: new Error("Usable API HTTP 502: bad gateway"),
    });
    let invalidated = 0;
    const projector = new PoiFragmentProjector(ENV, sink, () => {
      invalidated += 1;
    });

    await expect(projector.project(POI)).rejects.toThrow("502");
    expect(invalidated).toBe(0);
  });

  test("aliases are optional — content omits the aliases block cleanly", async () => {
    const { sink, calls } = makeSink({ existing: null });
    const projector = new PoiFragmentProjector(ENV, sink);
    await projector.project({ ...POI, aliases: undefined });
    const fm = frontmatterFromContent(calls.create[0].content);
    expect(fm).toMatchObject({ key: "skarvenes_lykt" });
    expect((fm as Record<string, unknown>).aliases).toBeUndefined();
  });
});
