# Fishfacts AI Backend

Bun/Hono backend for Fishfacts AI events and J-meldinger ingestion.

## Local Setup

```sh
bun install
cp .env.example .env
docker compose up -d postgres
bun run db:migrate
bun run dev
```

Swagger UI is available at `http://localhost:3001/docs`.

## Flowcore Resources

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

`FLOWCORE_API_KEY` uses the modern `fc_...` secret format. Do not use legacy `keyId:keyValue` format.

Required scoped policy:

```json
[
  {
    "statementId": "fishfacts-ai-backend-datacore-access",
    "resource": "frn::jbiskur:data-core/ad37e770-4d43-4ebd-8166-401be5e0b513",
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

## Verification

```sh
bun test
bun run typecheck
bun run lint
```
