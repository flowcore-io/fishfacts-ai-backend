/**
 * ONE-OFF cleanup — run AFTER the Postgres job-state migration is deployed and
 * verified. The app no longer writes the legacy Usable job-state fragments
 * (`fishfacts-ai-backend-job-state-*`), so they go stale; this archives them so
 * they stop showing up in search / being re-indexed. (The harmful re-embedding
 * already stops on deploy — embedding only happens on WRITE — so this is tidiness.)
 *
 * Dry-run by default (lists what it would archive). Pass `--apply` to archive.
 * Env: USABLE_API_BASE_URL, USABLE_API_TOKEN, USABLE_WORKSPACE_ID,
 *      JOB_STATE_FRAGMENT_TYPE_ID (optional, has the prod default).
 *
 *   bun scripts/archive-job-state-fragments.ts            # dry run
 *   bun scripts/archive-job-state-fragments.ts --apply    # archive
 */
const base = process.env.USABLE_API_BASE_URL;
const token = process.env.USABLE_API_TOKEN;
const ws = process.env.USABLE_WORKSPACE_ID;
const typeId =
  process.env.JOB_STATE_FRAGMENT_TYPE_ID ??
  "11da02d0-b033-43a4-acd1-96f9e193cc86";
const apply = process.argv.includes("--apply");

if (!base || !token || !ws) {
  console.error(
    "Missing USABLE_API_BASE_URL / USABLE_API_TOKEN / USABLE_WORKSPACE_ID",
  );
  process.exit(1);
}

const headers = {
  accept: "application/json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
// JOB_STATE_FRAGMENT_TYPE_ID is dedicated to job-state fragments, so listing by
// it scopes us correctly. (The list endpoint does NOT return `key`, so we can't
// filter on that — we match the title prefix as a belt-and-suspenders check.)
const TITLE_PREFIX = "FishFacts Job State:";

const found: { id: string; title: string }[] = [];
let offset = 0;
for (;;) {
  const url = `${base}/memory-fragments?workspaceId=${ws}&fragmentTypeId=${typeId}&limit=200&offset=${offset}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`list failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const json = (await res.json()) as {
    fragments?: { id: string; title?: string }[];
    totalCount?: number;
  };
  const rows = json.fragments ?? [];
  for (const f of rows) {
    if ((f.title ?? "").startsWith(TITLE_PREFIX))
      found.push({ id: f.id, title: f.title ?? "" });
  }
  if (rows.length === 0) break;
  offset += rows.length;
  if (offset >= (json.totalCount ?? offset)) break;
}

console.log(`Found ${found.length} job-state fragment(s):`);
for (const f of found) console.log(`  ${f.title}  (${f.id})`);

if (!apply) {
  console.log("\nDry run — pass --apply to archive these.");
  process.exit(0);
}

for (const f of found) {
  const res = await fetch(`${base}/memory-fragments/${f.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "archived" }),
  });
  console.log(`archive ${f.title}: HTTP ${res.status}`);
}
console.log("Done.");
