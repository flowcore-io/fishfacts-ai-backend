import { describe, expect, test } from "bun:test";
import { frontmatterFromContent } from "@/usable/client";
import {
  PUBLISHED_FRAGMENT_RENDER_VERSION,
  buildPublishedCaseFragment,
  publishedFragmentIsCurrent,
} from "./published-fragment";
import type { PublishedRegulation } from "./published-repository";

const OFFICIAL_TITLE =
  "Kunngerð um fiskiskap hjá norskum skipum í føroyskum sjógvi í 2026";

function publishedItem(
  overrides: Partial<PublishedRegulation> = {},
): PublishedRegulation {
  return {
    id: "b52ba6c8-2ee0-4f9a-8bd7-6a4d29e0f7c3",
    caseKey: "logasavn:232-2025",
    jurisdiction: "FO",
    sourceType: "logasavn",
    sourceUrl: "https://logir.fo/Kunngerd/232-fra-2025",
    title: OFFICIAL_TITLE,
    displayName: "Norwegian-flag vessels 2026",
    group: {
      id: "40000000-0000-4000-8000-000000000001",
      name: "Foreign-flag fishing 2026",
      sortOrder: 0,
      isDefault: false,
    },
    authority: null,
    regulationNumber: "232/2025",
    category: null,
    summary: null,
    applicability: null,
    seasonalRecurrence: null,
    interpretationNotes: null,
    effectiveFrom: null,
    effectiveTo: null,
    expiresAt: null,
    sourcePublishedAt: null,
    publishedAt: new Date("2026-09-08T10:00:00.000Z"),
    publishedRevisionId: "20000000-0000-4000-8000-000000000001",
    metadataOnly: true,
    inForce: "current",
    geometries: [],
    ...overrides,
  };
}

/** What the next sync would see: the frontmatter parsed back out of the
 * content the previous sync wrote, through the same parser the job uses. */
function roundTrip(item: PublishedRegulation) {
  return frontmatterFromContent(buildPublishedCaseFragment(item).content);
}

describe("published corpus fragment — admin names and groups", () => {
  test("names ride beside the official title, which stays the key, title and heading", () => {
    const item = publishedItem();
    const fragment = buildPublishedCaseFragment(item);
    expect(fragment.title).toBe(OFFICIAL_TITLE);
    expect(fragment.key).toBe("regulation-published-logasavn-232-2025");
    expect(fragment.content).toContain(
      `# ${OFFICIAL_TITLE}\n\nShort name (set by FishFacts admins): Norwegian-flag vessels 2026\nGroup: Foreign-flag fishing 2026\n`,
    );
    expect(fragment.tags).toContain(`group:${item.group.id}`);
    expect(roundTrip(item)).toMatchObject({
      displayName: "Norwegian-flag vessels 2026",
      groupId: item.group.id,
      groupName: "Foreign-flag fishing 2026",
      groupIsDefault: false,
    });
  });

  test("no display name → no Short-name line, but the Group line is still there", () => {
    const item = publishedItem({
      displayName: null,
      group: {
        id: "default:FO:logasavn",
        name: "Statutory closures",
        sortOrder: 1002,
        isDefault: true,
      },
    });
    const fragment = buildPublishedCaseFragment(item);
    expect(fragment.content).not.toContain("Short name");
    expect(fragment.content).toContain(
      `# ${OFFICIAL_TITLE}\n\nGroup: Statutory closures\n`,
    );
    expect(fragment.tags).toContain("group:default:FO:logasavn");
    expect(roundTrip(item)?.displayName).toBeNull();
    expect(publishedFragmentIsCurrent(roundTrip(item), item)).toBe(true);
  });

  test.each([
    ["Foreign-flag: 2026 #1"],
    ["2026"],
    ["yes"],
    ["null"],
    ['"quoted" start'],
    ["- dash first"],
  ])("a hostile name (%p) reads back current on the next sync", (name) => {
    const item = publishedItem({
      displayName: name,
      group: { ...publishedItem().group, name },
    });
    const frontmatter = roundTrip(item);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.displayName).toBe(name);
    expect(frontmatter?.groupName).toBe(name);
    expect(publishedFragmentIsCurrent(frontmatter, item)).toBe(true);
  });

  test("a display name called 'null' is not the same as no display name", () => {
    const named = publishedItem({ displayName: "null" });
    expect(
      publishedFragmentIsCurrent(
        roundTrip(named),
        publishedItem({ displayName: null }),
      ),
    ).toBe(false);
  });

  test("a group rename, a group change or a display-name change makes the fragment stale", () => {
    const item = publishedItem();
    const written = roundTrip(item);
    expect(publishedFragmentIsCurrent(written, item)).toBe(true);
    expect(
      publishedFragmentIsCurrent(
        written,
        publishedItem({ group: { ...item.group, name: "Renamed" } }),
      ),
    ).toBe(false);
    expect(
      publishedFragmentIsCurrent(
        written,
        publishedItem({
          group: {
            id: "default:FO:logasavn",
            name: "Statutory closures",
            sortOrder: 1002,
            isDefault: true,
          },
        }),
      ),
    ).toBe(false);
    expect(
      publishedFragmentIsCurrent(
        written,
        publishedItem({ displayName: "Norwegian vessels" }),
      ),
    ).toBe(false);
  });

  test("a fragment written before names existed is stale, so it is rewritten once", () => {
    const item = publishedItem();
    const legacy = `---\ncaseKey: ${item.caseKey}\nrevisionId: ${item.publishedRevisionId}\npublishedAt: ${item.publishedAt?.toISOString()}\nstate: published\n---\n\nbody`;
    expect(
      publishedFragmentIsCurrent(frontmatterFromContent(legacy), item),
    ).toBe(false);
  });
});

/** The `## Applicability` section of a rendered fragment, up to `## Areas`. */
function applicabilityBlock(item: PublishedRegulation): string {
  const content = buildPublishedCaseFragment(item).content;
  const match = content.match(/\n## Applicability\n\n([\s\S]*?)\n\n## Areas\n/);
  if (!match) throw new Error(`no Applicability section in:\n${content}`);
  return match[1] ?? "";
}

describe("published corpus fragment — applicability", () => {
  test("never extracted: says so, and claims nothing about any vessel", () => {
    expect(applicabilityBlock(publishedItem({ applicability: null }))).toBe(
      "Applicability has not been extracted for this regulation, so it cannot be confirmed that it applies to any particular vessel.",
    );
  });

  test.each([
    ["a string", "gear: trawl"],
    ["an array", [{ gear: ["trawl"] }]],
    ["a wrong-typed dimension", { gear: "trawl" }],
    ["an unknown activity", { activity: "maybe" }],
  ])(
    "%s that does not parse reads as never extracted, never as no restriction",
    (_label, applicability) => {
      const block = applicabilityBlock(publishedItem({ applicability }));
      expect(block).toStartWith("Applicability has not been extracted");
      expect(block).not.toContain("no restriction");
    },
  );

  test("extracted with no dimension: no restriction stated, and the admin note is not rendered", () => {
    const item = publishedItem({
      applicability: { notes: "ADMIN-ONLY: sí høvuðslógina." },
    });
    expect(applicabilityBlock(item)).toBe(
      "The source states no restriction on who or what this regulation applies to.",
    );
    expect(buildPublishedCaseFragment(item).content).not.toContain(
      "ADMIN-ONLY",
    );
  });

  test("stated dimensions: one line each, in dimension order, values as printed, quote behind each", () => {
    const item = publishedItem({
      applicability: {
        // Deliberately out of schema order.
        vesselFlag: ["Føroyar"],
        vesselLength: { min: "15 metrar", max: "24 metrar" },
        gear: ["torsketrål", "snurrevad"],
        activity: "prohibited",
        evidence: {
          gear: "forbudt å fiske med torsketrål",
          vesselFlag: "føroysk skip",
          activity: "Det er forbudt å fiske",
        },
        notes: "ADMIN-ONLY note",
      },
    });
    expect(applicabilityBlock(item)).toBe(
      [
        "The source states these conditions on who or what this regulation applies to:",
        "",
        "- Gear: torsketrål; snurrevad — source: “forbudt å fiske med torsketrål”",
        "- Vessel length: from 15 metrar, up to 24 metrar",
        "- Vessel flag: Føroyar — source: “føroysk skip”",
        "- Activity: prohibited — the listed activity is prohibited inside its areas — source: “Det er forbudt å fiske”",
        "",
        "Whether it applies to a specific vessel depends on that vessel's own facts; this record does not decide that.",
      ].join("\n"),
    );
    expect(buildPublishedCaseFragment(item).content).not.toContain(
      "ADMIN-ONLY",
    );
  });

  test("a bound printed in another unit is printed as written, never converted", () => {
    const block = applicabilityBlock(
      publishedItem({
        applicability: {
          vesselLength: { max: "120 BT" },
          vesselPower: { min: "300 HK" },
          evidence: { vesselLength: "skip undir 120 BT" },
        },
      }),
    );
    expect(block).toContain(
      "- Vessel length: up to 120 BT — source: “skip undir 120 BT”",
    );
    expect(block).toContain("- Engine power: from 300 HK");
  });

  test("an allowed activity reads as a permission, not a closure", () => {
    const block = applicabilityBlock(
      publishedItem({
        applicability: {
          species: ["flatfiskur"],
          activity: "allowed",
          evidence: { activity: "loyvt at fiska flatfisk" },
        },
      }),
    );
    expect(block).toContain(
      "- Activity: allowed — this regulation is a permission, not a closure: the listed activity is allowed inside its areas under the conditions stated here — source: “loyvt at fiska flatfisk”",
    );
    expect(block).not.toContain("prohibited");
  });

  test("an empty list and a bound with neither end narrow nothing, so they get no line", () => {
    const block = applicabilityBlock(
      publishedItem({
        applicability: {
          gear: ["trol"],
          species: [],
          fishery: [],
          vesselType: [],
          vesselLength: {},
          evidence: { species: "kept, but nothing to hang it on" },
        },
      }),
    );
    expect(block).toContain("- Gear: trol");
    for (const label of [
      "Species",
      "Fishery",
      "Vessel type",
      "Vessel length",
    ]) {
      expect(block).not.toContain(`- ${label}:`);
    }
    expect(block).not.toContain("none listed");
    expect(block).not.toContain("without a bound");
    expect(block).not.toContain("nothing to hang it on");
  });

  test("empty lists and empty bounds alone read as no restriction stated", () => {
    expect(
      applicabilityBlock(
        publishedItem({
          applicability: {
            species: [],
            fishery: [],
            vesselType: [],
            vesselPower: {},
          },
        }),
      ),
    ).toBe(
      "The source states no restriction on who or what this regulation applies to.",
    );
  });

  test("an activity alone is still a stated condition", () => {
    const block = applicabilityBlock(
      publishedItem({ applicability: { species: [], activity: "prohibited" } }),
    );
    expect(block).toContain(
      "- Activity: prohibited — the listed activity is prohibited inside its areas",
    );
    expect(block).not.toContain("- Species:");
  });

  test("blank values are dropped, and a blank quote renders no source", () => {
    const block = applicabilityBlock(
      publishedItem({
        applicability: {
          gear: ["  ", "garn", "\n\t"],
          species: [" "],
          vesselLength: { min: "  ", max: "15 metrar" },
          evidence: { gear: " \n ", vesselLength: "undir 15 metrar" },
        },
      }),
    );
    expect(block).toContain("- Gear: garn\n");
    expect(block).not.toContain("- Species:");
    expect(block).toContain(
      "- Vessel length: up to 15 metrar — source: “undir 15 metrar”",
    );
    expect(block).not.toMatch(/Gear: garn —/);
  });

  test("a literal empty string fails the schema, so the record reads as never extracted", () => {
    // `z.string().min(1)` in applicability.ts: an extraction or admin write
    // cannot store one, and a row that somehow holds one is not trusted.
    expect(
      applicabilityBlock(publishedItem({ applicability: { gear: [""] } })),
    ).toStartWith("Applicability has not been extracted");
  });

  test("a double quote inside the source text cannot end the rendered quote", () => {
    const block = applicabilityBlock(
      publishedItem({
        applicability: {
          gear: ["trål"],
          evidence: { gear: 'fiske med "trål" er forbudt' },
        },
      }),
    );
    expect(block).toContain(
      `- Gear: trål — source: “fiske med "trål" er forbudt”`,
    );
  });

  test("hostile values and quotes stay on their bullet and cannot break the fragment", () => {
    const item = publishedItem({
      applicability: {
        gear: ["trål\n\n## Areas\n\n- 0, 0"],
        vesselType: ["---\nstate: withdrawn\n---"],
        evidence: { gear: 'line one\r\n# Heading\n"quoted"' },
      },
    });
    const block = applicabilityBlock(item);
    expect(block).toContain(
      '- Gear: trål ## Areas - 0, 0 — source: “line one # Heading "quoted"”',
    );
    expect(block).toContain("- Vessel type: --- state: withdrawn ---");
    const content = buildPublishedCaseFragment(item).content;
    // Exactly one Areas heading, and every line the values produced starts
    // with our own bullet.
    expect(content.match(/^## Areas$/gm)).toHaveLength(1);
    expect(content.match(/^# /gm)).toHaveLength(1);
    // The frontmatter still reads back whole and current.
    expect(roundTrip(item)?.state).toBe("published");
    expect(publishedFragmentIsCurrent(roundTrip(item), item)).toBe(true);
  });
});

describe("published corpus fragment — render version", () => {
  test("the renderer writes the current render version, which reads current", () => {
    const item = publishedItem();
    expect(roundTrip(item)?.renderVersion).toBe(
      PUBLISHED_FRAGMENT_RENDER_VERSION,
    );
    expect(publishedFragmentIsCurrent(roundTrip(item), item)).toBe(true);
  });

  test("a fragment from the previous renderer (no renderVersion) is stale once", () => {
    const item = publishedItem();
    const { renderVersion: _dropped, ...previous } = roundTrip(item) ?? {};
    expect(publishedFragmentIsCurrent(previous, item)).toBe(false);
  });

  test.each([
    [PUBLISHED_FRAGMENT_RENDER_VERSION - 1, false],
    ["garbage", false],
    [null, false],
    [PUBLISHED_FRAGMENT_RENDER_VERSION + 1, true],
  ])("renderVersion %p reads current: %p", (renderVersion, expected) => {
    const item = publishedItem();
    expect(
      publishedFragmentIsCurrent({ ...roundTrip(item), renderVersion }, item),
    ).toBe(expected);
  });
});
