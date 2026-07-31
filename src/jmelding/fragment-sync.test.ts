import { describe, expect, test } from "bun:test";
import type { Env } from "@/env";
import { JMeldingFragmentProjector } from "@/jobs/jmelding-fragments";
import type { UsableApiClient } from "@/usable/client";
import {
  type JMeldingGeoSyncRow,
  announcementFromRow,
  decideFragmentSync,
  fragmentDiffers,
  parseLimitFlag,
} from "./fragment-sync";

const BODY =
  "Fiskeridirektoratet har den 6. juli 2023 fastsatt følgende forskrift om stenging av et område.";

/**
 * A fragment in the shape `JMeldingFragmentProjector` writes it — in particular
 * with the window as the *raw source strings* the Fiskeridir scraper stores,
 * which is what the read model's instants have to be compared against.
 */
function fragmentContent(
  overrides: Partial<Record<string, string>> = {},
  body: string = BODY,
) {
  const fields: Record<string, string> = {
    source: "fiskeridir-jmeldinger",
    type: "announcement",
    region: "NO",
    authority: "Fiskeridirektoratet (Norway)",
    key: "fishfacts-jmelding-j-123-2023",
    title: "J-123-2023 Forskrift om stenging",
    jm_number: "J-123-2023",
    status: "archived",
    url: "https://www.fiskeridir.no/yrkesfiske/regelverk-og-reguleringer/j-meldinger/j-123-2023",
    published_at: "2023-07-06",
    announcement_created_at: "2023-07-06T00:00:00.000Z",
    valid_from: "07.07.2023",
    valid_to: "31.07.2023",
    category: "Regulering",
    signature: "sig-123",
    content_hash: "hash-123",
    last_checked_at: "2023-08-01T12:00:00.000Z",
    ...overrides,
  };
  const yaml = Object.entries(fields)
    .map(([key, value]) => `${key}: "${value}"`)
    .join("\n");
  return [
    "---",
    yaml,
    "tags:",
    "  - fishfacts",
    `  - status:${fields.status}`,
    "---",
    "",
    `# ${fields.title}`,
    "",
    "## Metadata",
    "",
    `- **Status:** ${fields.status}`,
    `- **Valid from:** ${fields.valid_from}`,
    `- **Valid to:** ${fields.valid_to}`,
    `- **Last checked:** ${fields.last_checked_at}`,
    "",
    "## Announcement",
    "",
    body,
    "",
  ].join("\n");
}

/** The row as `jmelding_geo` holds it: instants, derived by the geo projector. */
function geoRow(
  overrides: Partial<JMeldingGeoSyncRow> = {},
): JMeldingGeoSyncRow {
  return {
    jm_number: "J-123-2023",
    fragment_key: "fishfacts-jmelding-j-123-2023",
    title: "J-123-2023 Forskrift om stenging",
    status: "archived",
    region: "NO",
    category: "Regulering",
    url: "https://www.fiskeridir.no/yrkesfiske/regelverk-og-reguleringer/j-meldinger/j-123-2023",
    signature: "sig-123",
    valid_from: new Date("2023-07-07T00:00:00.000Z"),
    valid_to: new Date("2023-07-31T23:59:59.999Z"),
    ...overrides,
  };
}

const frontmatterOf = (
  fields: Partial<Record<string, string>>,
): Record<string, unknown> => fields;

describe("fragmentDiffers", () => {
  test("a raw day-first window matches the instants derived from it", () => {
    // Regression: comparing "07.07.2023" against "2023-07-07T00:00:00.000Z"
    // literally marks every correctly-scraped NO fragment as out of sync, and
    // --apply then re-embeds ~6 800 fragments to change nothing.
    expect(
      fragmentDiffers(
        frontmatterOf({
          status: "archived",
          valid_from: "07.07.2023",
          valid_to: "31.07.2023",
        }),
        geoRow(),
      ),
    ).toBe(false);
  });

  test("an already-rebuilt fragment carrying instants still matches", () => {
    // The rebuild writes the instant, so a second run must see no drift.
    expect(
      fragmentDiffers(
        frontmatterOf({
          status: "archived",
          valid_from: "2023-07-07T00:00:00.000Z",
          valid_to: "2023-07-31T23:59:59.999Z",
        }),
        geoRow(),
      ),
    ).toBe(false);
  });

  test("an empty window matches null columns", () => {
    expect(
      fragmentDiffers(
        frontmatterOf({ status: "current", valid_from: "", valid_to: "" }),
        geoRow({ status: "current", valid_from: null, valid_to: null }),
      ),
    ).toBe(false);
  });

  test("a stale status differs even when the window agrees", () => {
    expect(
      fragmentDiffers(
        frontmatterOf({
          status: "current",
          valid_from: "07.07.2023",
          valid_to: "31.07.2023",
        }),
        geoRow({ status: "archived" }),
      ),
    ).toBe(true);
  });

  test("unparseable Vørn prose never matches, so the fragment is cleaned", () => {
    expect(
      fragmentDiffers(
        frontmatterOf({
          status: "current",
          valid_from: "í dag, hin 22",
          valid_to: "",
        }),
        geoRow({ status: "current", valid_from: null, valid_to: null }),
      ),
    ).toBe(true);
  });

  test("absent frontmatter differs from any row", () => {
    expect(fragmentDiffers({}, geoRow())).toBe(true);
  });
});

describe("announcementFromRow", () => {
  const frontmatter = frontmatterOf({
    published_at: "2023-07-06",
    announcement_created_at: "2023-07-06T00:00:00.000Z",
    content_hash: "hash-123",
    last_checked_at: "2023-08-01T12:00:00.000Z",
  });

  test("takes the window and status from the row, as instants", () => {
    const announcement = announcementFromRow(geoRow(), frontmatter, BODY);
    expect(announcement.status).toBe("archived");
    expect(announcement.validFrom).toBe("2023-07-07T00:00:00.000Z");
    expect(announcement.validTo).toBe("2023-07-31T23:59:59.999Z");
    expect(announcement.bodyMarkdown).toBe(BODY);
  });

  test("carries over everything the database does not keep", () => {
    const announcement = announcementFromRow(geoRow(), frontmatter, BODY);
    expect(announcement.publishedAt).toBe("2023-07-06");
    expect(announcement.createdAt).toBe("2023-07-06T00:00:00.000Z");
    expect(announcement.contentHash).toBe("hash-123");
  });

  test("preserves last_checked_at rather than claiming a fresh source check", () => {
    // Nothing was fetched from the source, so the rebuilt fragment must not
    // present a 2023 notice as verified today.
    const announcement = announcementFromRow(
      geoRow(),
      frontmatter,
      BODY,
      new Date("2026-07-31T00:00:00.000Z"),
    );
    expect(announcement.checkedAt).toBe("2023-08-01T12:00:00.000Z");
  });

  test("falls back to now only when the fragment has no last check", () => {
    const announcement = announcementFromRow(
      geoRow(),
      frontmatterOf({}),
      BODY,
      new Date("2026-07-31T00:00:00.000Z"),
    );
    expect(announcement.checkedAt).toBe("2026-07-31T00:00:00.000Z");
  });

  test("a null category becomes absent, not the string 'null'", () => {
    const announcement = announcementFromRow(
      geoRow({ category: null }),
      frontmatter,
      BODY,
    );
    expect(announcement.category).toBeUndefined();
  });
});

describe("decideFragmentSync", () => {
  test("leaves a correctly-scraped fragment alone", () => {
    expect(decideFragmentSync(geoRow(), fragmentContent())).toEqual({
      action: "in-sync",
    });
  });

  test("rebuilds a fragment whose status drifted, reporting what it claimed", () => {
    const decision = decideFragmentSync(
      geoRow(),
      fragmentContent({ status: "current" }),
    );
    expect(decision.action).toBe("rewrite");
    if (decision.action !== "rewrite") return;
    expect(decision.claims).toEqual({
      status: "current",
      validFrom: "07.07.2023",
      validTo: "31.07.2023",
    });
    expect(decision.announcement.status).toBe("archived");
    expect(decision.announcement.bodyMarkdown).toBe(BODY);
  });

  test("refuses to rebuild when the announcement body cannot be recovered", () => {
    // The body exists only in the fragment — jmelding_geo keeps none — so a
    // rebuild here would replace the announcement with buildMarkdown's
    // "No body content extracted from source page." placeholder for good.
    const decision = decideFragmentSync(
      geoRow(),
      fragmentContent({ status: "current" }, ""),
    );
    expect(decision.action).toBe("unrecoverable");
  });

  test("refuses a fragment with no '## Announcement' section at all", () => {
    const decision = decideFragmentSync(
      geoRow(),
      '---\nstatus: "current"\n---\n\n# J-123-2023\n\nHand-edited notes.\n',
    );
    expect(decision.action).toBe("unrecoverable");
  });

  test("refuses a fragment with no content, which can tell you nothing", () => {
    expect(decideFragmentSync(geoRow(), undefined).action).toBe(
      "unrecoverable",
    );
    expect(decideFragmentSync(geoRow(), "   ").action).toBe("unrecoverable");
  });
});

describe("rebuild convergence", () => {
  /**
   * The decision plus the projector, end to end: what the rebuild actually
   * writes must keep the announcement and must read as in sync on the next run
   * — otherwise every run rewrites (and re-embeds) the whole corpus.
   */
  test("a rebuilt fragment keeps its body and no longer differs", async () => {
    const env = {
      USABLE_WORKSPACE_ID: "workspace-1",
      JMELDING_FRAGMENT_TYPE_ID: "type-1",
    } as Env;
    let written: string | undefined;
    const usable = {
      getFragmentByKey: async () => ({ id: "fragment-1" }),
      updateFragment: async (_id: string, input: { content: string }) => {
        written = input.content;
        return { id: "fragment-1" };
      },
    } as unknown as UsableApiClient;

    const row = geoRow();
    const decision = decideFragmentSync(
      row,
      fragmentContent({ status: "current" }),
    );
    expect(decision.action).toBe("rewrite");
    if (decision.action !== "rewrite") return;

    await new JMeldingFragmentProjector(env, usable).project(
      decision.announcement,
    );

    expect(written).toContain(BODY);
    expect(written).toContain('status: "archived"');
    expect(written).toContain("- **Last checked:** 2023-08-01T12:00:00.000Z");
    expect(decideFragmentSync(row, written)).toEqual({ action: "in-sync" });
  });
});

describe("parseLimitFlag", () => {
  test("no flag means no limit", () => {
    expect(parseLimitFlag(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a positive integer is the limit", () => {
    expect(parseLimitFlag("20")).toBe(20);
  });

  test("a malformed value throws instead of silently meaning 'no limit'", () => {
    // `--limit --apply` used to parse as NaN, and `synced >= NaN` is always
    // false: 20 intended writes become ~6 800 against production.
    for (const raw of ["--apply", "twenty", "", "0", "-1", "1.5"]) {
      expect(() => parseLimitFlag(raw)).toThrow("--limit must be a positive");
    }
  });
});
