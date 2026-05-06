import type { Env } from "@/env";
import type { JMeldingAnnouncementDiscovered } from "@/events/contracts";
import type { UsableApiClient } from "@/usable/client";

const MAX_CONTENT_CHARS = 60000;

function yamlEscape(value?: string) {
  return (value ?? "").replace(/"/g, '\\"');
}

function sanitizeText(value: string) {
  return Array.from(value.replace(/\r\n/g, "\n"))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 10 || code === 9 || code >= 32;
    })
    .join("");
}

function slugFromUrl(url: string) {
  const normalized = url.toLowerCase();
  const match = normalized.match(/\/j-meldinger\/(j-[a-z0-9-]+)/);
  if (match?.[1]) return match[1];
  return normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function jmeldingFragmentKey(url: string) {
  return `fishfacts-jmelding-${slugFromUrl(url)}`;
}

function normalizedCreatedAt(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now()) {
    return undefined;
  }
  return parsed.toISOString();
}

function buildMarkdown(input: {
  key: string;
  item: JMeldingAnnouncementDiscovered;
}) {
  const item = input.item;
  const tags = [
    "fishfacts",
    "fiskeridir",
    "j-melding",
    "announcement",
    `status:${item.status}`,
  ];
  const body = sanitizeText(
    item.bodyMarkdown?.trim() || "No body content extracted from source page.",
  );
  const lines = [
    "---",
    'source: "fiskeridir-jmeldinger"',
    'type: "announcement"',
    `key: "${yamlEscape(input.key)}"`,
    `title: "${yamlEscape(item.title)}"`,
    `jm_number: "${yamlEscape(item.jmNumber)}"`,
    `status: "${item.status}"`,
    `url: "${yamlEscape(item.url)}"`,
    `published_at: "${yamlEscape(item.publishedAt)}"`,
    `announcement_created_at: "${yamlEscape(item.createdAt)}"`,
    `valid_from: "${yamlEscape(item.validFrom)}"`,
    `valid_to: "${yamlEscape(item.validTo)}"`,
    `category: "${yamlEscape(item.category)}"`,
    `signature: "${yamlEscape(item.signature)}"`,
    `content_hash: "${yamlEscape(item.contentHash)}"`,
    `last_checked_at: "${item.checkedAt}"`,
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    "---",
    "",
    `# ${item.title}`,
    "",
    "## Metadata",
    "",
    `- **J-melding:** ${item.jmNumber ?? "unknown"}`,
    `- **Status:** ${item.status}`,
    `- **Published:** ${item.publishedAt ?? "unknown"}`,
    `- **Valid from:** ${item.validFrom ?? "unknown"}`,
    `- **Valid to:** ${item.validTo ?? "unknown"}`,
    `- **Category:** ${item.category ?? "unknown"}`,
    `- **Source URL:** ${item.url}`,
    `- **Last checked:** ${item.checkedAt}`,
    "",
    "## Announcement",
    "",
    body,
    "",
  ];
  const content = sanitizeText(lines.join("\n"));
  if (content.length <= MAX_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_CONTENT_CHARS - 80).trimEnd()}\n\n_This announcement was truncated to fit storage limits._\n`;
}

export class JMeldingFragmentProjector {
  constructor(
    private readonly env: Env,
    private readonly usable: UsableApiClient,
  ) {}

  async project(item: JMeldingAnnouncementDiscovered) {
    const key = jmeldingFragmentKey(item.url);
    const tags = [
      "fishfacts",
      "fiskeridir",
      "j-melding",
      "announcement",
      `status:${item.status}`,
      `fragment-key:${key}`,
    ];
    const content = buildMarkdown({ key, item });
    const summary = `Fiskeridir J-melding ${item.jmNumber ?? ""} (${item.status})`;
    const existing = await this.usable.getFragmentByKey(
      this.env.USABLE_WORKSPACE_ID,
      key,
    );
    if (existing) {
      const fragment = await this.usable.updateFragment(existing.id, {
        fragmentTypeId: this.env.JMELDING_FRAGMENT_TYPE_ID,
        title: item.title,
        summary,
        content,
        tags,
      });
      return { key, fragmentId: fragment?.id ?? existing.id, mode: "updated" };
    }

    try {
      const created = await this.usable.createFragment({
        workspaceId: this.env.USABLE_WORKSPACE_ID,
        fragmentTypeId: this.env.JMELDING_FRAGMENT_TYPE_ID,
        key,
        title: item.title,
        summary,
        content,
        tags,
        createdAt: normalizedCreatedAt(item.createdAt),
      });
      return { key, fragmentId: created?.id, mode: "created" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("409")) throw error;
      const duplicate = await this.usable.getFragmentByKey(
        this.env.USABLE_WORKSPACE_ID,
        key,
      );
      if (!duplicate) throw error;
      await this.usable.updateFragment(duplicate.id, {
        fragmentTypeId: this.env.JMELDING_FRAGMENT_TYPE_ID,
        title: item.title,
        summary,
        content,
        tags,
      });
      return { key, fragmentId: duplicate.id, mode: "updated" };
    }
  }
}
