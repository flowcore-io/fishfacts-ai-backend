/**
 * Closure-fragment maintenance. The Fiskistofa WFS `fid` used to leak into the
 * sourceKey (per-request token → unstable), so earlier runs created orphan KB
 * fragments under stale keys. This lists every `fishfacts-closure-*` fragment in
 * the workspace, computes the CURRENT valid stable key set from the live
 * scrapers, and reports (DRY RUN) or deletes (apply) the orphans.
 *
 *   bun scripts/closure-fragments-cleanup.ts          # dry run (counts only)
 *   bun scripts/closure-fragments-cleanup.ts --apply  # delete orphans
 *
 * Norwegian J-meldinger (`fishfacts-jmelding-*`) are never touched.
 */
import {
  FISKISTOFA_LAYERS,
  fetchFiskistofaLayer,
  fetchVornBan,
  listVornBanUrls,
  vornSourceKey,
} from "@/closures/scrapers";
import { loadEnv } from "@/env";
import { jmeldingFragmentKey } from "@/jobs/jmelding-fragments";

const APPLY = process.argv.includes("--apply");
const env = loadEnv();
const BASE = env.USABLE_API_BASE_URL;
const WS = env.USABLE_WORKSPACE_ID;
const TYPE = env.JMELDING_FRAGMENT_TYPE_ID;

function authHeaders(extra: Record<string, string> = {}) {
  return {
    accept: "application/json",
    authorization: `Bearer ${env.USABLE_API_TOKEN}`,
    ...extra,
  };
}

async function validKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const url of await listVornBanUrls()) {
    keys.add(
      jmeldingFragmentKey(url, { region: "FO", jmNumber: vornSourceKey(url) }),
    );
  }
  for (const { layer, closureType } of FISKISTOFA_LAYERS) {
    const recs = (
      await fetchFiskistofaLayer(layer, closureType).catch(() => [])
    ).filter((r) => r.points.length > 0);
    for (const r of recs) {
      keys.add(
        jmeldingFragmentKey(r.url ?? "", {
          region: "IS",
          jmNumber: r.sourceKey,
        }),
      );
    }
  }
  return keys;
}

function keyOf(fragment: Record<string, unknown>): string | undefined {
  if (typeof fragment.key === "string") return fragment.key;
  const tags = Array.isArray(fragment.tags) ? fragment.tags : [];
  const tag = tags.find(
    (t) => typeof t === "string" && t.startsWith("fragment-key:"),
  );
  return typeof tag === "string"
    ? tag.slice("fragment-key:".length)
    : undefined;
}

async function listAll(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const limit = 200;
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      workspaceId: WS,
      fragmentTypeId: TYPE,
      limit: String(limit),
      offset: String(offset),
    });
    const res = await fetch(`${BASE}/memory-fragments?${params}`, {
      headers: authHeaders(),
    });
    if (!res.ok)
      throw new Error(`list HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      fragments?: Array<Record<string, unknown>>;
      count?: number;
      totalCount?: number;
    };
    const rows = json.fragments ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    offset += rows.length;
    if (json.totalCount != null && offset >= json.totalCount) break;
  }
  return out;
}

async function deleteFragment(id: string): Promise<number> {
  const res = await fetch(`${BASE}/memory-fragments/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return res.status;
}

const valid = await validKeys();
const all = await listAll();
const closures = all.filter((f) => {
  const k = keyOf(f);
  return typeof k === "string" && k.startsWith("fishfacts-closure-");
});
const orphans = closures.filter((f) => {
  const k = keyOf(f);
  return k != null && !valid.has(k);
});

console.log(`valid stable closure keys: ${valid.size}`);
console.log(`total fragments of type:   ${all.length}`);
console.log(`closure fragments:         ${closures.length}`);
console.log(`ORPHAN closure fragments:  ${orphans.length}`);
console.log("sample orphans:");
for (const f of orphans.slice(0, 5)) console.log("  ", f.id, keyOf(f));

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to delete the orphans.");
} else {
  let ok = 0;
  let fail = 0;
  for (const f of orphans) {
    const status = await deleteFragment(String(f.id));
    if (status >= 200 && status < 300) ok++;
    else {
      fail++;
      if (fail <= 3) console.log(`  delete ${f.id} -> HTTP ${status}`);
    }
  }
  console.log(`\nDELETED ok=${ok} fail=${fail}`);
}
