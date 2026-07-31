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

// Vørn typo's the YEAR as well as the spelling. Nr 15 is published at
// `-nr-15-20206` — their slug and page title both read "20206", while the
// image on the same page is named `veidibann-nr-15-2026.jpg`. Captured
// 2026-07-31; `…-15-20206` returns 200 and `…-15-2020` returns 404.
const SITEMAP_TYPOD_YEAR = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-15-20206</loc></url>
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

  test("keeps a typo'd 5-digit year whole instead of truncating to a 404", () => {
    const urls = matchVornBanUrls(SITEMAP_TYPOD_YEAR);
    // The bug: `[0-9]{4}` has no trailing boundary, so it cut the slug to
    // `…-nr-15-2020` — a URL that 404s. We then parsed the 404 body and stored
    // an in-force ban with no geometry and no validity.
    expect(urls).toEqual([
      "https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-15-20206",
    ]);
    expect(urls[0].endsWith("-2020")).toBe(false);
  });

  test("vornSourceKey keeps a malformed year verbatim, never truncated", () => {
    // Faithful-to-source beats plausible-but-wrong: `-15-2020` would read as a
    // 2020 ban. The real year reaches the user through the title instead.
    expect(
      vornSourceKey(
        "https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-15-20206",
      ),
    ).toBe("vorn-veidibann-15-20206");
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

describe("parseVornBan titles nr 15 from the body, not Vørn's typo'd slug", () => {
  // Verbatim from the live page, 2026-07-31. Note the legal citation carries
  // 2019 and the validity sentence carries 2026 — a naive first-year-in-body
  // scan would title this ban 2019.
  const url =
    "https://www.vorn.fo/fiskiveida/bradfeingis-veidibann/veidibann-nr-15-20206";
  const html = `<html><body><p>Við heimild í Løgtingslóg nr. 152 frá 23.
    desember 2019, § 59, ásetir Fiskiveiðueftirlitið bráðfeingis veiðibann fyri
    trol, á eini leið í landnyrðing úr Fugloynni.</p><p>6232 N – 0520 W
    6230 N – 0506 W 6227 N – 0510 W 6228 N – 0520 W 6232 N – 0520 W</p>
    <p>Veiðibannið er galdandi frá í dag, hin 7. juli 2026 klokkan 19:00 til
    4. august 2026 klokkan 19:00.</p></body></html>`;

  test("takes the year from the validity sentence", () => {
    expect(parseVornBan(url, html).title).toBe("Veiðibann nr. 15 - 2026");
  });

  test("does not take the year from the Løgtingslóg citation", () => {
    expect(parseVornBan(url, html).title).not.toContain("2019");
  });

  test("recovers the geometry the truncated 404 URL cost us", () => {
    const rec = parseVornBan(url, html);
    expect(rec.points).toHaveLength(5);
    expect(rec.geometryType).toBe("polygon");
    expect(rec.points[0].lat).toBeCloseTo(62 + 32 / 60, 5);
    expect(rec.points[0].lng).toBeCloseTo(-(5 + 20 / 60), 5);
  });

  test("is in force on 31 Jul 2026 and archived after its window closes", () => {
    const rec = parseVornBan(url, html);
    expect(rec.validFrom).toBe("2026-07-07T19:00:00.000Z");
    expect(rec.validTo).toBe("2026-08-04T19:00:00.000Z");
    // The old behaviour stored no end date at all, and an absent end never
    // expires — so this ban would have stayed "active" forever.
    expect(rec.status).toBe("active");
  });

  test("falls back to the slug year when the validity sentence is unreadable", () => {
    const noValidity = `<html><body><p>Við heimild.</p><p>6232 N – 0520 W
      6230 N – 0506 W 6227 N – 0510 W</p></body></html>`;
    expect(parseVornBan(url, noValidity).title).toBe(
      "Veiðibann nr. 15 - 20206",
    );
  });
});
