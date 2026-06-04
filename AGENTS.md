# AGENTS.md — fishfacts-ai-backend operational notes

Concise runbook for working on this repo. Read alongside `README.md`.

## Project shape

- Bun + Hono backend; Drizzle on Postgres + PostGIS.
- Writes events to Flowcore via `@flowcore/pathways` SDK (single in-process virtual pathway).
- Scheduled scrape of Fiskeridir J-meldinger; ingest via `POST /api/transformer`; persists `generic_events`, `jmelding_chunk_queue`, `jmelding_geo` tables.
- Production deploy: namespace `public-sites`, deployment `fishfacts-ai-backend` (ECR image, tag = release version). `SERVICE_URL=https://fishfacts-ai.usable.dev`.

## Flowcore wiring (production)

- Tenant: `fishfacts` (id `93b95bc0-2d6c-461b-ba87-b1b4f4382dd9`)
- Data core: `fishfacts-ai-backend` (id `4a8126e3-1211-4e40-8a59-7141d3f82bca`)
- Pathway (virtual): `fishfacts-ai-backend` (id `0dd5b8e3-4728-4390-a302-5b6cdaa7ae8d`)
- Flow types: `fishfacts-generic.0`, `fishfacts-announcement.0`
- Tenant API key: `fc_<keyId>_<secret>` in K8s secret `fishfacts-ai-backend-credentials` (env `FLOWCORE_API_KEY`), policy `fishfacts-ai-backend-datacore-access` (read/write/ingest/fetch on the data core)
- `autoProvision.pathway: true` — SDK upserts the pathway by name (`PUT /api/v1/pathways/by-name/fishfacts-ai-backend`) on every boot. Labels and `virtualConfig.flowTypes` are overwritten from `src/pathways.ts:pathwayLabels` + builder config. **CP UI header renders the `name` and `description` label keys** — keep both set in `pathwayLabels`.
- Production = virtual + cluster: only the leader pod runs the pump (Postgres-coordinated leader election via `pathway_leases` / `pathway_instances`). Pump cursor lives in `pathway_pump_state`. These are SDK-managed runtime tables, not in our drizzle schema.

## Auth header for the Flowcore CP

The SDK uses this format for ApiKey auth against `data-pathways.api.flowcore.io`:

```
Authorization: ApiKey ${apiKey.split("_")[1]}:${apiKey}
```

For `fc_<keyId>_<secret>` → `ApiKey <keyId>:fc_<keyId>_<secret>`. Plain `Authorization: <key>` or `ApiKey <key>` returns 401.

## Verifying pulses + restart commands without SDK logs

The `PathwaysBuilder` is constructed without a logger, so the default `NoopLogger` swallows all SDK output. To verify the pump is alive, query the CP directly:

```sh
# Pulses (per-flowType last-seen)
curl -s "https://data-pathways.api.flowcore.io/api/v1/pathways/<pathwayId>/pump-status" \
  -H "Authorization: ApiKey ${KEYID}:${FULL_KEY}" | jq

# Pending restart commands (poller hits this every ~5s)
curl -s "https://data-pathways.api.flowcore.io/api/v1/pathways/<pathwayId>/commands/pending" \
  -H "Authorization: ApiKey ${KEYID}:${FULL_KEY}" | jq
```

`pump-status.pulses[].healthy: false` means lastPulseAgeMs > ~60s — pump stopped or never started. `lastPulseAgeMs` should stay ≈ pulse interval (default 30s).

## Triggering the J-meldinger backfill

The hourly cron only scrapes new items. To re-emit events for every J-melding (e.g. when switching tenants), call `/api/jobs/run` with `refreshExisting: true`. Two-step:

```sh
# 1. Get a FishFacts session token. NOTE: form-encoded body, not JSON.
TOKEN=$(curl -s -X POST https://api-test.fishfacts.fo/api/v3/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Application: FISHFACTS" \
  --data-urlencode "username=<user>" --data-urlencode "password=<pass>" \
  | jq -r .data.token)

# 2. Trigger the job. Body MUST be { jobId, args } — sending { name } silently falls
# through to runAll() (mode: "all"), which runs without your args.
curl -s -X POST https://fishfacts-ai.usable.dev/api/jobs/run \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"jobId":"fiskeridir-jmeldinger","args":{"refreshExisting":true}}'
```

Returns `202` + `{ mode: "single", runId, ... }`. The scheduler (cron `0 * * * *`) is enabled in prod — if the cron's run is already in flight you'll get `500 internal_server_error` with `Job ... is already running`. Poll `GET /api/jobs/state` (same auth) until `runningJobIds` no longer contains the id, then retry.

OpenAPI for the FishFacts login: <https://api-test.fishfacts.fo/v3/api-docs/api-v3> (the field name and content-type matter — `application/x-www-form-urlencoded`, body `username=...&password=...`).

## Triggering the Sildelaget catch backfill

The hourly cron uses `selectedTime=168`. For manual backfill, send the duration in hours as `args.selectedTime` (for example `8760` = one year). Set `backfill=true` when existing entries must be re-emitted, e.g. to import route metadata. Body MUST be `{ jobId, args }`.

```sh
curl -s -X POST https://fishfacts-ai.usable.dev/api/jobs/run \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"jobId":"sildelaget-catchjournal","args":{"selectedTime":8760,"backfill":true}}'
```

Writes still go through Flowcore only; do not add a direct DB fallback.

## Drizzle (`drizzle.config.ts`)

```ts
extensionsFilters: ["postgis"],
tablesFilter: ["generic_events", "jmelding_*", "!pathway_*"],
```

- `extensionsFilters: ["postgis"]` keeps drizzle-kit's hands off `spatial_ref_sys`, `geometry_columns`, `geography_columns` (postgis owns them; Postgres rejects the drop anyway).
- The explicit `!pathway_*` negation is required even with positive `tablesFilter` patterns. Reason: drizzle-kit's filter (`bin.cjs:81902`) treats negate matchers as inclusive — every non-excluded table passes via the negate matchers, so positive patterns alone don't keep `pathway_*` out.
- CI runs `drizzle-kit push --force` against `postgis/postgis:16-3.4-alpine` (not `postgres:16-alpine` — the geometry column needs PostGIS installed).

## Release flow

- Conventional commits → release-please cuts a release PR (`chore(main): release X.Y.Z`).
- "Build and Deploy to Production" GHA tags the image, pushes to ECR, rolls the deployment automatically. No manual deploy step.
- Local test workflow uses `bunx drizzle-kit push --force` for fresh DB; geo black-box tests rely on the PostGIS-enabled service image (see above).

## Common operational checks

```sh
# Pod + version
kubectl -n public-sites get pods -l app=fishfacts-ai-backend \
  -o jsonpath='{.items[*].spec.containers[0].image}'

# Cluster state (leader election + pump cursor)
kubectl -n public-sites exec deploy/fishfacts-ai-backend -- sh -c \
  'bun -e "const sql=(await import(\"postgres\")).default(process.env.DATABASE_URL); \
   console.log(await sql\`select * from pathway_instances\`); \
   console.log(await sql\`select * from pathway_leases\`); \
   await sql.end()"'

# Recent non-health logs
kubectl -n public-sites logs deploy/fishfacts-ai-backend --since=5m | grep -v "/health"
```

## Gotchas

- **No SDK logs**: the `PathwaysBuilder` config in `src/pathways.ts` doesn't pass a `logger`. Plan provisioning/pulse/cluster behavior using CP API queries, not pod logs.
- **autoProvision.pathway must be `true`**: otherwise the SDK doesn't PUT /by-name, so it never learns `pathwayId`, so pulses + restart-command poller are silently disabled. The pathway being pre-created in the UI is *not* sufficient.
- **/api/jobs/run wrong key silently does the wrong thing**: `{ name: "..." }` is ignored; `runAll` fires (`mode: "all"` in the response is the tell). Must be `jobId` + `args`.
- **FishFacts login is form-encoded**, despite returning JSON. JSON body returns 401 "Bad credentials".
- **Usable returns intermittent HTTP 502**: every `JobStateStore.save` (state-fragment write) and `JobStateStore.load` can fail transiently. As of v1.5.1 the runner releases its in-memory `runningJobs` lock if the initial pre-IIFE save throws; the cron retries cleanly next hour. Symptom of regression: `/api/jobs/state` shows `runningJobIds` populated with no matching `[JobRunner] starting job` log + `Scheduled run failed: Usable API HTTP 5xx` — pod restart is the only mitigation.
