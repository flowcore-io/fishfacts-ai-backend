import { afterEach, describe, expect, test } from "bun:test";
import type { Env } from "../../src/env";
import {
  UsableApiClient,
  frontmatterFromContent,
} from "../../src/usable/client";

// Content shaped like a real POI fragment as the REST API returns it: the
// YAML block is retained in `content`; the parsed `frontmatter` column is
// NOT included in REST responses (internal search projection).
const POI_CONTENT = `---
kind: point-of-interest
key: hanstholm_fyr
aliases:
  - Hanstholm fyr
  - Hanstholmen fyr
lat: 57.11269
lng: 8.59861
source: Danish register (Wikidata Q723232)
---

Hanstholm fyr — lighthouse on the NW coast of Denmark.`;

describe("frontmatterFromContent", () => {
  test("parses the YAML block of a POI-shaped fragment", () => {
    const fm = frontmatterFromContent(POI_CONTENT);
    expect(fm).toEqual({
      kind: "point-of-interest",
      key: "hanstholm_fyr",
      aliases: ["Hanstholm fyr", "Hanstholmen fyr"],
      lat: 57.11269,
      lng: 8.59861,
      source: "Danish register (Wikidata Q723232)",
    });
  });

  test("returns null when there is no frontmatter block", () => {
    expect(frontmatterFromContent("Just prose, no YAML.")).toBeNull();
    expect(frontmatterFromContent(undefined)).toBeNull();
    expect(frontmatterFromContent("")).toBeNull();
  });

  test("returns null for an unclosed or malformed block", () => {
    expect(frontmatterFromContent("---\nkey: value")).toBeNull();
    expect(frontmatterFromContent("---\n: [unbalanced\n---\nbody")).toBeNull();
  });

  test("accepts the '...' closing delimiter", () => {
    expect(frontmatterFromContent("---\nkey: x\n...\nbody")).toEqual({
      key: "x",
    });
  });
});

describe("UsableApiClient frontmatter wiring", () => {
  const env = {
    USABLE_API_BASE_URL: "https://usable.test/api",
    USABLE_API_TOKEN: "test-token",
  } as Env;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubListResponse(rows: unknown[]) {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          fragments: rows,
          count: rows.length,
          totalCount: rows.length,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
  }

  test("REST-shaped list rows (YAML only in content) yield parsed frontmatter", async () => {
    stubListResponse([
      { id: "frag-1", title: "POI: Hanstholm fyr", content: POI_CONTENT },
    ]);
    const [fragment] = await new UsableApiClient(env).listFragments({
      workspaceId: "ws",
      fragmentTypeId: "type",
    });
    expect(fragment?.frontmatter?.key).toBe("hanstholm_fyr");
    expect(fragment?.frontmatter?.lat).toBe(57.11269);
  });

  test("a pre-parsed frontmatter field wins over different YAML in content", async () => {
    stubListResponse([
      {
        id: "frag-1",
        content: POI_CONTENT, // says hanstholm_fyr
        frontmatter: { key: "preparsed_fyr", lat: 1, lng: 2 },
      },
    ]);
    const [fragment] = await new UsableApiClient(env).listFragments({
      workspaceId: "ws",
      fragmentTypeId: "type",
    });
    expect(fragment?.frontmatter).toEqual({
      key: "preparsed_fyr",
      lat: 1,
      lng: 2,
    });
  });
});
