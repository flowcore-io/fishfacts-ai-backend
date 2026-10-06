import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchFiskeridirPolygons,
  mergeRepeatedParagraphs,
  polygonIsPlausible,
  polygonVertexCount,
} from "../../src/closures/fiskeridir-wfs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const RING = [
  [25.0, 70.0],
  [25.1, 70.0],
  [25.1, 70.1],
  [25.0, 70.1],
  [25.0, 70.0],
];

function respondWith(body: unknown, status = 200) {
  const content = body as { features?: Array<Record<string, unknown>> };
  const features = content.features?.map((f, i) => ({ ...f, id: i + 1 }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return new Response(
      JSON.stringify(
        url.searchParams.has("returnIdsOnly") && features
          ? { objectIds: features.map((f) => f.id) }
          : features
            ? { ...content, features }
            : body,
      ),
      { status },
    );
  }) as unknown as typeof fetch;
}

function feature(
  properties: Record<string, unknown> | null,
  geometry: unknown,
) {
  return { type: "Feature", properties, geometry };
}

describe("polygonVertexCount / polygonIsPlausible", () => {
  test("counts every vertex of every ring, holes included", () => {
    // § 6 of the seinot forskrift is ONE polygon with 108 island holes; the
    // count must include them or the size it reports is meaningless.
    const hole = [
      [25.02, 70.02],
      [25.04, 70.02],
      [25.04, 70.04],
      [25.02, 70.02],
    ];
    expect(
      polygonVertexCount({ type: "Polygon", coordinates: [RING, hole] }),
    ).toBe(9);
    expect(
      polygonVertexCount({
        type: "MultiPolygon",
        coordinates: [[RING], [RING, hole]],
      }),
    ).toBe(14);
  });

  test("accepts a shape inside the Nordic box", () => {
    expect(polygonIsPlausible({ type: "Polygon", coordinates: [RING] })).toBe(
      true,
    );
  });

  test("rejects lat/lon swapped, non-finite and empty shapes rather than repairing them", () => {
    const swapped = RING.map(([lon, lat]) => [lat, lon]);
    expect(
      polygonIsPlausible({ type: "Polygon", coordinates: [swapped] }),
    ).toBe(false);
    expect(
      polygonIsPlausible({
        type: "Polygon",
        coordinates: [[[Number.NaN, 70], ...RING.slice(1)]],
      }),
    ).toBe(false);
    expect(polygonIsPlausible({ type: "Polygon", coordinates: [] })).toBe(
      false,
    );
    // A ring must close on itself to be a ring at all: fewer than four
    // positions cannot.
    expect(
      polygonIsPlausible({ type: "Polygon", coordinates: [RING.slice(0, 3)] }),
    ).toBe(false);
  });
});

describe("fetchFiskeridirPolygons", () => {
  test("keeps polygons and multipolygons, keyed by J-melding and paragraph", async () => {
    respondWith({
      features: [
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 2, navn: " Tanasnaget " },
          { type: "Polygon", coordinates: [RING] },
        ),
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 6, navn: "Sværholt" },
          { type: "MultiPolygon", coordinates: [[RING]] },
        ),
      ],
    });
    const { polygons, skipped } = await fetchFiskeridirPolygons();
    expect(skipped).toBe(0);
    expect(polygons.map((p) => [p.jmNumber, p.paragraph])).toEqual([
      ["J-153-2026", 2],
      ["J-153-2026", 6],
    ]);
    expect(polygons[0].name).toBe("Tanasnaget");
    expect(polygons[0].geometry.type).toBe("Polygon");
    expect(polygons[0].vertexCount).toBe(5);
  });

  test("stores the geometry exactly as the server returned it", async () => {
    const geometry = { type: "Polygon" as const, coordinates: [RING] };
    respondWith({
      features: [
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 2, navn: "A" },
          geometry,
        ),
      ],
    });
    const { polygons } = await fetchFiskeridirPolygons();
    expect(polygons[0].geometry).toEqual(geometry);
  });

  test("skips and counts what it cannot use, never fixing it", async () => {
    respondWith({
      features: [
        // no paragraph — cannot be joined to an area
        feature(
          { jmelding_navn: "J-153-2026", paragraf: null },
          { type: "Polygon", coordinates: [RING] },
        ),
        // no J-melding
        feature({ paragraf: 1 }, { type: "Polygon", coordinates: [RING] }),
        // not a polygon
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 3 },
          { type: "Point", coordinates: [25, 70] },
        ),
        // no geometry at all
        feature({ jmelding_navn: "J-153-2026", paragraf: 4 }, null),
        // outside the Nordic box
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 5 },
          {
            type: "Polygon",
            coordinates: [RING.map(([lon, lat]) => [lat, lon])],
          },
        ),
        // the one good one
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 6 },
          { type: "Polygon", coordinates: [RING] },
        ),
      ],
    });
    const { polygons, skipped } = await fetchFiskeridirPolygons();
    expect(polygons.map((p) => p.paragraph)).toEqual([6]);
    expect(skipped).toBe(5);
  });

  test("a failing register is an error, not an empty result", async () => {
    // An empty list would read as "the authority publishes nothing" and, one
    // layer up, as a clean sync.
    respondWith({}, 503);
    await expect(fetchFiskeridirPolygons()).rejects.toThrow("503");
    respondWith({ error: { message: "boom" } });
    await expect(fetchFiskeridirPolygons()).rejects.toThrow("boom");
  });
});

describe("one shape per J-melding and §", () => {
  const HOLE = [
    [25.02, 70.02],
    [25.04, 70.02],
    [25.04, 70.04],
    [25.02, 70.02],
  ];
  const OTHER = RING.map(([lon, lat]) => [lon + 1, lat]);

  test("features repeating a § become one MultiPolygon that keeps every ring", async () => {
    // The register has never done this (65 features, 65 keys). Nothing forbids
    // it either, and a § naming two separate waters is how it would look.
    // Keeping one would drop geometry; keeping both breaks the key the review
    // screen joins on.
    respondWith({
      features: [
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 6, navn: "Sværholt" },
          { type: "Polygon", coordinates: [RING, HOLE] },
        ),
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 6, navn: "Sværholt 2" },
          { type: "Polygon", coordinates: [OTHER] },
        ),
        feature(
          { jmelding_navn: "J-153-2026", paragraf: 7, navn: "Hasvik" },
          { type: "Polygon", coordinates: [RING] },
        ),
      ],
    });
    const { polygons, merged, skipped } = await fetchFiskeridirPolygons();
    expect(skipped).toBe(0);
    expect(merged).toBe(1);
    expect(polygons.map((p) => p.paragraph)).toEqual([6, 7]);

    const six = polygons[0];
    expect(six.geometry.type).toBe("MultiPolygon");
    if (six.geometry.type === "MultiPolygon") {
      // Both parts, each with its own rings — the island hole is not lost.
      expect(six.geometry.coordinates).toEqual([[RING, HOLE], [OTHER]]);
    }
    expect(six.vertexCount).toBe(5 + 4 + 5);
    expect(six.name).toBe("Sværholt");
  });

  test("a MultiPolygon part is flattened into the merge, not nested", () => {
    const merged = mergeRepeatedParagraphs([
      {
        jmNumber: "J-153-2026",
        paragraph: 1,
        name: null,
        geometry: { type: "MultiPolygon", coordinates: [[RING], [OTHER]] },
        vertexCount: 10,
      },
      {
        jmNumber: "J-153-2026",
        paragraph: 1,
        name: "Lafjorden",
        geometry: { type: "Polygon", coordinates: [RING] },
        vertexCount: 5,
      },
    ]);
    expect(merged.merged).toBe(1);
    expect(merged.polygons).toHaveLength(1);
    const geometry = merged.polygons[0].geometry;
    expect(geometry.type).toBe("MultiPolygon");
    if (geometry.type === "MultiPolygon") {
      expect(geometry.coordinates).toEqual([[RING], [OTHER], [RING]]);
    }
    // The first name found wins even when the first feature had none.
    expect(merged.polygons[0].name).toBe("Lafjorden");
  });

  test("the same § under different J-meldinger is not a repeat", () => {
    const shape = { type: "Polygon" as const, coordinates: [RING] };
    const result = mergeRepeatedParagraphs([
      {
        jmNumber: "J-153-2026",
        paragraph: 1,
        name: null,
        geometry: shape,
        vertexCount: 5,
      },
      {
        jmNumber: "J-158-2026",
        paragraph: 1,
        name: null,
        geometry: shape,
        vertexCount: 5,
      },
    ]);
    expect(result.merged).toBe(0);
    expect(result.polygons).toHaveLength(2);
  });
});

test("refuses a truncated feature observation instead of freezing a partial inventory", async () => {
  let n = 0;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        ++n === 1
          ? { objectIds: [1, 2] }
          : {
              features: [
                {
                  ...feature(
                    { jmelding_navn: "J-1-2026", paragraf: 1 },
                    { type: "Polygon", coordinates: [RING] },
                  ),
                  id: 1,
                },
              ],
            },
      ),
    )) as unknown as typeof fetch;
  await expect(fetchFiskeridirPolygons()).rejects.toThrow(
    "incomplete feature inventory",
  );
});
test("refuses duplicate inventory ids and transfer-limit responses", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ objectIds: [1, 1] }),
    )) as unknown as typeof fetch;
  await expect(fetchFiskeridirPolygons()).rejects.toThrow(
    "inventory missing or invalid",
  );
  let n = 0;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        ++n === 1
          ? { objectIds: [1] }
          : {
              exceededTransferLimit: true,
              features: [
                {
                  ...feature(
                    { jmelding_navn: "J-1-2026", paragraf: 1 },
                    { type: "Polygon", coordinates: [RING] },
                  ),
                  id: 1,
                },
              ],
            },
      ),
    )) as unknown as typeof fetch;
  await expect(fetchFiskeridirPolygons()).rejects.toThrow(
    "incomplete feature inventory",
  );
});
