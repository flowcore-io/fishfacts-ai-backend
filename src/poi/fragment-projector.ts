import type { Env } from "@/env";
import type { PoiCreated } from "@/events/contracts";
import type { UsableFragment } from "@/usable/client";
import { POI_TITLE_PREFIX } from "./repository";

/**
 * JSON strings are valid YAML double-quoted scalars, and JSON.stringify
 * escapes backslashes/quotes/newlines correctly — a hand-rolled quote-only
 * escape would emit invalid YAML for a value like `C:\path`, silently
 * dropping the POI from the gazetteer at read time.
 */
function yamlQuote(value: string) {
  return JSON.stringify(value);
}

/** The slice of `UsableApiClient` the projector needs (narrow for tests). */
export type PoiFragmentSink = {
  getFragmentByKey(
    workspaceId: string,
    key: string,
  ): Promise<UsableFragment | null>;
  createFragment(input: {
    workspaceId: string;
    fragmentTypeId: string;
    key: string;
    title: string;
    summary: string;
    content: string;
    tags: string[];
  }): Promise<UsableFragment | null>;
  updateFragment(
    fragmentId: string,
    input: {
      fragmentTypeId?: string;
      title?: string;
      summary?: string;
      content?: string;
      tags?: string[];
    },
  ): Promise<UsableFragment | null>;
};

/**
 * Fragment content matching the hand-migrated POI fragments (task 940ccb2c):
 * a YAML frontmatter block — the read side (`PoiRepository`) parses `key`,
 * `lat`, `lng`, `aliases`, `source` back out of it via
 * `frontmatterFromContent` — followed by a short provenance body. Deleting the
 * fragment cleanly reverts resolution of this name to the fail-safe ask.
 */
function buildMarkdown(poi: PoiCreated) {
  const lines = [
    "---",
    'kind: "point-of-interest"',
    `key: ${yamlQuote(poi.key)}`,
    ...(poi.aliases && poi.aliases.length > 0
      ? ["aliases:", ...poi.aliases.map((alias) => `  - ${yamlQuote(alias)}`)]
      : []),
    `lat: ${poi.lat}`,
    `lng: ${poi.lng}`,
    `source: ${yamlQuote(poi.source)}`,
    `verifiedBy: ${yamlQuote(poi.verifiedBy)}`,
    `verifiedAt: ${yamlQuote(poi.verifiedAt)}`,
    "---",
    "",
    `${poi.title} — Point-of-Interest gazetteer entry for narrative boundary`,
    "resolution (`draw_regulation_boundary`). Saved via the admin `save_poi`",
    `chat tool by **${poi.verifiedBy}** on ${poi.verifiedAt}.`,
    "",
    `- **Coordinate:** ${poi.lat}, ${poi.lng}`,
    `- **Source:** ${poi.source}`,
    "",
    "Delete this fragment to revert the resolver to the fail-safe ask for",
    "this name (takes effect on the next gazetteer refresh).",
    "",
  ];
  return lines.join("\n");
}

/**
 * The ONLY writer of POI fragments — consumes `poi.created.0` off the pump
 * (the `POST /api/poi` route emits the event and never touches Usable, per
 * the events-only rule enforced by test/architecture.test.ts). Upserts by
 * fragment key, so replaying the event stream converges and re-teaching an
 * existing key corrects it (the event history keeps every prior value).
 */
export class PoiFragmentProjector {
  constructor(
    private readonly env: Pick<
      Env,
      "USABLE_WORKSPACE_ID" | "POI_FRAGMENT_TYPE_ID"
    >,
    private readonly usable: PoiFragmentSink,
    /** Called after a successful write — wired to `PoiRepository.invalidate`
     * so the new POI is servable before the read cache's TTL rolls over. */
    private readonly onProjected?: () => void,
  ) {}

  async project(poi: PoiCreated) {
    const title = `${POI_TITLE_PREFIX}${poi.title}`;
    const summary = `Point-of-Interest gazetteer entry ${poi.key} (${poi.lat}, ${poi.lng}) — ${poi.source}, verified by ${poi.verifiedBy}.`;
    const content = buildMarkdown(poi);
    const tags = [
      "point-of-interest",
      "gazetteer",
      "draw_regulation_boundary",
      "save-poi",
    ];
    const result = await this.upsert(poi.key, {
      title,
      summary,
      content,
      tags,
    });
    this.onProjected?.();
    return result;
  }

  private async upsert(
    key: string,
    fields: { title: string; summary: string; content: string; tags: string[] },
  ) {
    const patch = {
      fragmentTypeId: this.env.POI_FRAGMENT_TYPE_ID,
      ...fields,
    };
    const existing = await this.usable.getFragmentByKey(
      this.env.USABLE_WORKSPACE_ID,
      key,
    );
    if (existing) {
      const fragment = await this.usable.updateFragment(existing.id, patch);
      return { key, fragmentId: fragment?.id ?? existing.id, mode: "updated" };
    }
    try {
      const created = await this.usable.createFragment({
        workspaceId: this.env.USABLE_WORKSPACE_ID,
        key,
        ...patch,
      });
      return { key, fragmentId: created?.id, mode: "created" };
    } catch (error) {
      // 409 = another writer created the key between our read and create;
      // fall through to an update of that fragment (same as jmelding-fragments).
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("409")) throw error;
      const duplicate = await this.usable.getFragmentByKey(
        this.env.USABLE_WORKSPACE_ID,
        key,
      );
      if (!duplicate) throw error;
      await this.usable.updateFragment(duplicate.id, patch);
      return { key, fragmentId: duplicate.id, mode: "updated" };
    }
  }
}
