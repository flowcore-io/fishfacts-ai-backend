# Fishfacts AI Backend

Bun/Hono backend for Fishfacts AI events and J-meldinger ingestion.

## Local Setup

```sh
bun install
cp .env.example .env
bun run services:up       # starts postgres on host port 15432
bun run db:migrate
bun run dev
```

Other service commands: `services:down` (stop), `services:logs` (follow), `services:reset` (wipe volume + restart).

Swagger UI is available at `http://localhost:3033/docs`.

## Flowcore Resources

### Development (jbiskur)

Local `.env` points here.

- Tenant id: `72f3643c-c593-4e00-94a1-cadb82685490`
- Tenant slug: `jbiskur`
- Data core: `fishfacts-ai-backend`
- Data core id: `ad37e770-4d43-4ebd-8166-401be5e0b513`
- Flow type: `fishfacts-generic.0`
- Flow type id: `51e0eeba-5af6-4889-9815-91a6462cba6e`
- Event type: `generic.received.0`
- Event type id: `51de6d94-e8f3-4975-ab4c-747a8acc47ae`
- Announcement flow type: `fishfacts-announcement.0`
- Announcement event type: `jmelding.announcement.discovered.0`
- API key: `fishfacts-ai-backend-local-active`
- API key id: `4r7Dt6RzWCRaqpTni8UqSm`
- IAM policy: `fishfacts-ai-backend-local-datacore-access`
- IAM policy id: `2eae0fd8-3084-4643-a74b-e4470f687a58`

### Production (fishfacts)

Deployed service uses this tenant. API key value lives in 1Password ("Flowcore - fishfacts-ai-backend prod") and in K8s secret `fishfacts-ai-backend-credentials`.

- Tenant id: `93b95bc0-2d6c-461b-ba87-b1b4f4382dd9`
- Tenant slug: `fishfacts`
- Data core: `fishfacts-ai-backend`
- Data core id: `4a8126e3-1211-4e40-8a59-7141d3f82bca`
- Flow type: `fishfacts-generic.0`
- Flow type id: `debc688e-f154-4558-a3ee-5a694fafb0d3`
- Event type: `generic.received.0`
- Event type id: `bf1fce6b-e797-47ba-a262-10fe029bd70d`
- Announcement flow type: `fishfacts-announcement.0`
- Announcement flow type id: `d8810d94-03c6-490f-ad7e-b54c0050bc88`
- Announcement event type: `jmelding.announcement.discovered.0`
- Announcement event type id: `80b9d5c6-7e2a-4cba-bf91-eb980c2915b6`

PROD pathway is upserted by the SDK on startup via `PUT /api/v1/pathways/by-name/fishfacts-ai-backend` (`autoProvision.pathway: true`). The upsert is idempotent on `(tenant, name)` — it returns the existing `pathwayId`, which the SDK then uses to auto-configure pulse reporting and the restart-command poller. Labels are overwritten from `pathwayLabels` on every boot, so the builder config is the source of truth.

### Shared

`FLOWCORE_API_KEY` uses the modern `fc_...` secret format. Do not use legacy `keyId:keyValue` format.

Required scoped policy (substitute tenant slug and data core id per environment):

```json
[
  {
    "statementId": "fishfacts-ai-backend-datacore-access",
    "resource": "frn::<tenant-slug>:data-core/<data-core-id>",
    "action": ["read", "write", "ingest", "fetch"]
  }
]
```

## API

- `GET /health`
- `GET /openapi.json`
- `GET /docs`
- `POST /api/events`
- `GET /api/events/:id`
- `POST /api/jobs/cron`
- `POST /api/jobs/run`
- `GET /api/jobs/state`
- `POST /api/jobs/stop`
- `GET /api/jmeldinger` (list / `?bbox=` / `?near=&radiusKm=`)
- `GET /api/jmeldinger/:jmNumber`
- `POST /api/transformer`
- `POST /reset`

API mutation routes emit Flowcore events only. Domain read-model writes happen in transformer handling, not as a direct API fallback.

## J-meldinger

`POST /api/jobs/run` with `jobId=fiskeridir-jmeldinger` scrapes Fiskeridir, writes `fishfacts-announcement.0/jmelding.announcement.discovered.0` events to Flowcore, and relies on the transformer handler to reconstruct Usable fragments by deterministic key.

Required Usable env:

```sh
USABLE_WORKSPACE_ID=d72eb385-f9cf-43ec-bca5-cc80432877f8
USABLE_API_BASE_URL=https://usable.dev/api
USABLE_API_TOKEN=...
JMELDING_FRAGMENT_TYPE_ID=68505bca-a549-45eb-bca6-965f87195b89
JOB_STATE_FRAGMENT_TYPE_ID=11da02d0-b033-43a4-acd1-96f9e193cc86
```

## Sildelaget catch backfill

`POST /api/jobs/run` with `jobId=sildelaget-catchjournal` fetches the Sildelaget innmeldingsjournal export and writes `fishfacts-sildelaget-catchjournal.0/sildelaget.catchjournal.entry.observed.0` events to Flowcore. Cron uses `selectedTime=168`; manual backfill can set any positive hour duration, e.g. `8760` for one year. Set `backfill=true` to re-emit existing entries, including route metadata imports.

```sh
curl -s -X POST "$SERVICE_URL/api/jobs/run" \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"jobId":"sildelaget-catchjournal","args":{"selectedTime":8760,"backfill":true}}'
```

## J-meldinger Geo API

A read-model populated by the existing `JMeldingChunkAssembler` pipeline. Each `jmelding.announcement.discovered.0` event is parsed for embedded coordinates (Norwegian DMM long-form, DMM symbol-form, and DMS) and upserted into the `jmelding_geo` PostGIS-backed table. All endpoints require the `x-auth-token` header.

```sh
# Single record (also accepts the fragmentKey)
curl -H "x-auth-token: $TOKEN" http://localhost:3001/api/jmeldinger/j-67-2026

# List with filters + pagination
curl -H "x-auth-token: $TOKEN" \
  "http://localhost:3001/api/jmeldinger?status=current&hasGeo=true&limit=50"

# Bounding-box query (minLon,minLat,maxLon,maxLat in WGS84)
curl -H "x-auth-token: $TOKEN" \
  "http://localhost:3001/api/jmeldinger?bbox=24,70,32,72"

# Radius query (lon,lat center + radiusKm)
curl -H "x-auth-token: $TOKEN" \
  "http://localhost:3001/api/jmeldinger?near=24.93,71.18&radiusKm=20"
```

### PostGIS prerequisite

Local docker-compose uses `postgis/postgis:16-3.4-alpine`, which ships PostGIS and runs `CREATE EXTENSION postgis` as part of `drizzle/0002_jmelding_geo.sql`.

On the Azure `flowcore-customer` Flexible Server, PostGIS must first be added to the `azure.extensions` allow-list, and the extension must be created in the target database by the admin user. Run `scripts/enable-postgis-on-azure.sh` (see comments in that file for the exact `az`/`psql` commands). After that one-time setup the migration applies cleanly because `CREATE EXTENSION IF NOT EXISTS postgis` is a no-op when the extension exists.

### Backfill

After deployment, replay all historical announcements through the new geo projector by posting to `/reset` with the `x-pump-reset-secret` header (see `@flowcore/pathways` `ResetCallbackBody` for the exact body shape). Both projectors are idempotent (`ON CONFLICT DO UPDATE` for the geo row; the Usable fragment projector upserts by key).

## Lógasavn review queue

Faroese statutes swept out of Lógasavn land in `logasavn_review` as **pending**
and are not drawable until a human approves them. The sweep fills this table and
is structurally incapable of writing a verdict into it; these two ADMIN-only
endpoints are the only thing that can.

Populate or refresh the queue (manual — the job is not scheduled yet):

```sh
curl -s -X POST "$SERVICE_URL/api/jobs/run" \
  -H "Content-Type: application/json" -H "x-auth-token: $TOKEN" \
  -d '{"jobId":"logasavn-sweep","args":{"dryRun":true}}'   # counts only, writes nothing
```

List it. Every filter is optional; unfiltered returns everything current, ranked
in-force first, then by withheld geometry, then the fisheries ministry's own:

```sh
curl -s -H "x-auth-token: $TOKEN" "$SERVICE_URL/api/logasavn/review?inForce=true"
curl -s -H "x-auth-token: $TOKEN" "$SERVICE_URL/api/logasavn/review?reason=unreadable_geometry"
```

Every page carries a `summary` (`byStatus`, `byReason`, `inForcePending`) so you
can see what is left without a second call.

Decide. The URL targets `(fragmentId, contentHash)` because **an approval is an
approval of specific text** — if the sweep re-scraped the statute after you read
it, the write is refused with `409 stale_content_hash` and the current hash, so
you re-read rather than approving text you never saw:

```sh
# approve, with a reviewer-set seasonal window
curl -s -X PATCH "$SERVICE_URL/api/logasavn/review/$FRAGMENT_ID/$CONTENT_HASH" \
  -H "Content-Type: application/json" -H "x-auth-token: $TOKEN" \
  -d '{"status":"approved","recurrence":{"type":"annual","from":"02-01","to":"05-01"}}'

# decline — a reason is REQUIRED, because a decline is a recorded decision
curl -s -X PATCH "$SERVICE_URL/api/logasavn/review/$FRAGMENT_ID/$CONTENT_HASH" \
  -H "Content-Type: application/json" -H "x-auth-token: $TOKEN" \
  -d '{"status":"declined","declineReason":"treaty boundary, not a fishing closure"}'
```

`reviewedBy` is stamped from the authenticated admin and ignored if sent in the
body. `recurrence` can only be set here, never by the parser: no statute states
its own recurrence, so it is an interpretation rather than an extraction.

## Verification

```sh
bun test
bun run typecheck
bun run lint
```
