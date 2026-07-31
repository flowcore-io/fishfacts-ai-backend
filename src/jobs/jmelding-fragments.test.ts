import { describe, expect, test } from "bun:test";
import { announcementBodyFromContent } from "./jmelding-fragments";

// Verbatim from the production fragment for Veiðibann nr. 16 - 2026
// (`fishfacts-closure-vorn-veidibann-16-2026`), trimmed in the middle of the
// body only. This is the shape `scripts/jmelding-sync-fragments.ts` has to
// recover an announcement from before it rewrites the fragment.
const REAL_FRAGMENT = `---
source: "vorn-veidibann"
type: "closure"
region: "FO"
key: "fishfacts-closure-vorn-veidibann-16-2026"
status: "current"
valid_from: "í dag, hin 22"
valid_to: ""
tags:
  - fishfacts
  - status:current
---

# Veiðibann nr. 16 - 2026

## Metadata

- **Region:** FO (Vørn (Faroe Islands))
- **Status:** current
- **Valid from:** í dag, hin 22
- **Valid to:** unknown

## Announcement

Við heimild í Løgtingslóg nr. 152 frá 23. desember 2019, § 59, ásetir Fiskiveiðueftirlitið bráðfeingis veiðibann fyri trol á einum øki vestur úr Mykinesi 6220 N – 0836 W Veiðibannið er galdandi frá í dag, hin 22. juli 2026 klokkan 19:00 til 19. august 2026 klokkan 19:00.
`;

describe("announcementBodyFromContent", () => {
  test("recovers the announcement and nothing else", () => {
    const body = announcementBodyFromContent(REAL_FRAGMENT);
    expect(body.startsWith("Við heimild í Løgtingslóg")).toBe(true);
    expect(body.endsWith("klokkan 19:00.")).toBe(true);
    // None of the rendering comes back — those fields are rebuilt from the
    // corrected record, so carrying the stale copies over would reinstate them.
    // (The body legitimately contains "í dag, hin 22" — that is the source
    // sentence the bad `valid_from` was truncated out of, and it must survive.)
    expect(body).not.toContain("## Metadata");
    expect(body).not.toContain("- **Valid from:**");
    expect(body).not.toContain("status:current");
  });

  test("drops the truncation notice instead of stacking one per rebuild", () => {
    const truncated = `${REAL_FRAGMENT}\n_This announcement was truncated to fit storage limits._\n`;
    expect(announcementBodyFromContent(truncated)).toBe(
      announcementBodyFromContent(REAL_FRAGMENT),
    );
  });

  test("returns nothing rather than guessing when there is no body section", () => {
    expect(announcementBodyFromContent("# Title only")).toBe("");
    expect(announcementBodyFromContent(undefined)).toBe("");
  });

  test("does not mistake the word in a heading for the body marker", () => {
    // `indexOf` is anchored on a newline + the exact heading, so prose
    // mentioning the word cannot open the body early.
    const prose = REAL_FRAGMENT.replace(
      "## Metadata",
      "## Metadata\n\nSee the Announcement section below.",
    );
    expect(announcementBodyFromContent(prose).startsWith("Við heimild")).toBe(
      true,
    );
  });
});
