import { describe, expect, test } from "bun:test";
import { frontmatterFromContent } from "../../src/usable/client";

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
