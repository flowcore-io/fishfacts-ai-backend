import { describe, expect, test } from "bun:test";
import { matchVornBanUrls, vornSourceKey } from "./scrapers";

// Vørn typo's the ban slug per-announcement. The five current 2026 ban pages
// (live on vorn.fo/sitemap.xml, captured 2026-06-29) use four different
// spellings of "veiðibann" — the old `veid[ib]+ann` regex silently dropped
// nr 12 ("veidinann") and nr 13 ("veiibann"), which is why the assistant
// reported no active bans (QA r81/r83).
const SITEMAP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidbann-nr-9-2026</loc></url>
  <url><loc>https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-10-2026</loc></url>
  <url><loc>https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-11-2026</loc></url>
  <url><loc>https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidinann-nr-12-2026</loc></url>
  <url><loc>https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veiibann-nr-13-2026</loc></url>
  <url><loc>https://www.vorn.fo/kunning/tidindi/veidibann-nr-23-2025</loc></url>
  <url><loc>https://www.vorn.fo/fiskiveida/forsida</loc></url>
</urlset>`;

describe("Vørn veiðibann URL discovery", () => {
  test("matches all current ban slugs incl. typo'd nr 12/13", () => {
    const urls = matchVornBanUrls(SITEMAP_FIXTURE);
    for (const n of [9, 10, 11, 12, 13]) {
      expect(
        urls.some((u) => new RegExp(`-nr-${n}-2026$`).test(u)),
        `expected to match ban nr ${n}`,
      ).toBe(true);
    }
    expect(urls).toHaveLength(5);
  });

  test("excludes the /kunning/tidindi news archive and non-ban pages", () => {
    const urls = matchVornBanUrls(SITEMAP_FIXTURE);
    expect(urls.some((u) => u.includes("/kunning/tidindi/"))).toBe(false);
    expect(urls.some((u) => u.includes("/forsida"))).toBe(false);
  });

  test("vornSourceKey extracts nr+year from typo'd slugs", () => {
    expect(
      vornSourceKey(
        "https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidinann-nr-12-2026",
      ),
    ).toBe("vorn-veidibann-12-2026");
    expect(
      vornSourceKey(
        "https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veiibann-nr-13-2026",
      ),
    ).toBe("vorn-veidibann-13-2026");
  });
});
