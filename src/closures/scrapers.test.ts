import { describe, expect, test } from "bun:test";
import type { ClosurePoint } from "./scrapers";
import {
  matchVornBanUrls,
  normalizeVornRing,
  ringSelfIntersects,
  vornSourceKey,
} from "./scrapers";

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

// DDMM (deg + arc-minutes) → decimal, W longitudes negative. Mirrors parseVornBan.
const p = (
  latD: number,
  latM: number,
  lngD: number,
  lngM: number,
): ClosurePoint => ({
  lat: latD + latM / 60,
  lng: -(lngD + lngM / 60),
});

describe("Vørn ring normalisation", () => {
  test("drops the repeated closing vertex on a well-formed ring (no warning)", () => {
    // nr 10/11/12/13 convention: Vørn repeats P1 as the last point to close.
    const ring = [
      p(62, 39, 5, 51),
      p(62, 30, 6, 0),
      p(62, 20, 5, 40),
      p(62, 39, 5, 51),
    ];
    const { points, warning } = normalizeVornRing(ring);
    expect(points).toHaveLength(3);
    expect(warning).toBeNull();
  });

  test("repairs veiðibann nr. 14/2026's typo'd closing vertex", () => {
    // Live source lists 6 points; the last, 6014 N – 0700 W, is a digit
    // transposition of the first, 6104 N – 0700 W (the intended closing repeat).
    const p1 = p(61, 4, 7, 0);
    const p5 = p(60, 45, 6, 36);
    const raw = [
      p1,
      p(60, 57, 7, 6),
      p(60, 45, 7, 0),
      p(60, 39, 6, 54),
      p5,
      p(60, 14, 7, 0), // ← typo: should have been 6104 N (== p1)
    ];
    expect(ringSelfIntersects(raw)).toBe(true);

    const { points, warning } = normalizeVornRing(raw);
    // Phantom vertex dropped → clean 5-point pentagon that closes on P1.
    expect(points).toHaveLength(5);
    expect(points.at(-1)).toEqual(p5);
    expect(ringSelfIntersects(points)).toBe(false);
    // Surfaced so the source typo can be flagged to Vørn.
    expect(warning?.code).toBe("typo-unclosed-ring-repaired");
    expect(warning?.droppedPoint).toEqual(p(60, 14, 7, 0));
  });

  test("leaves a genuine unclosed but simple ring untouched (no warning)", () => {
    const ring = [p(62, 0, 7, 0), p(62, 0, 6, 30), p(61, 40, 6, 45)];
    const { points, warning } = normalizeVornRing(ring);
    expect(points).toHaveLength(3);
    expect(warning).toBeNull();
  });

  test("leaves a ≥4-vertex unclosed but simple ring untouched (no warning)", () => {
    // The conservative guarantee rests on the ≥4-vertex case: a simple ring
    // that does not repeat P1 must pass through, since ringSelfIntersects only
    // short-circuits below 4 vertices. Simple quadrilateral, unclosed.
    const ring = [
      p(62, 0, 7, 0),
      p(62, 0, 6, 30),
      p(61, 50, 6, 30),
      p(61, 50, 7, 0),
    ];
    expect(ringSelfIntersects(ring)).toBe(false);
    const { points, warning } = normalizeVornRing(ring);
    expect(points).toHaveLength(4);
    expect(warning).toBeNull();
  });
});
