import { describe, expect, test } from "bun:test";
import { matchVornBanUrls, parseVornBan, vornSourceKey } from "./scrapers";

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

describe("parseVornBan emits faithful raw geometry", () => {
  // Ring cleanup lives in the geo projector (see jmelding/vorn-ring.ts) so the
  // announcement event stays a lossless record of the source. The scraper must
  // therefore keep every listed point verbatim — including the closing repeat
  // and any typo.
  const url =
    "https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-14-2026";

  test("keeps nr. 14's typo'd 6th vertex (no repair at scrape time)", () => {
    const html = `<html><body><p>Við heimild í Løgtingslóg nr. 152 frá 23.
      desember 2019, § 59, ásetir Fiskiveiðueftirlitið bráðfeingis veiðibann
      fyri trol.</p><p>6104 N – 0700 W 6057 N – 0706 W 6045 N – 0700 W
      6039 N – 0654 W 6045 N – 0636 W 6014 N – 0700 W</p></body></html>`;
    const rec = parseVornBan(url, html);
    expect(rec.points).toHaveLength(6); // all six, incl. the 6014 N typo
    expect(rec.geometryType).toBe("polygon");
    // Last point is the far-south typo vertex, kept verbatim.
    expect(rec.points.at(-1)?.lat).toBeCloseTo(60 + 14 / 60, 5);
  });

  test("keeps the repeated closing vertex verbatim (no dedup)", () => {
    // nr 10/11/12/13 style: Vørn repeats P1 to close — the raw event keeps both.
    const html = `<html><body><p>Við heimild.</p><p>6239 N – 0551 W
      6230 N – 0510 W 6220 N – 0540 W 6239 N – 0551 W</p></body></html>`;
    const rec = parseVornBan(url, html);
    expect(rec.points).toHaveLength(4); // NOT deduped to 3
    expect(rec.points[0]).toEqual(rec.points[3]);
  });
});
