import { describe, expect, test } from "bun:test";
import { frontmatterFromContent } from "@/usable/client";
import {
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
