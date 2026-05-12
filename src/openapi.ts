export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Fishfacts AI Backend API",
    version: "0.1.0",
  },
  tags: [
    { name: "System", description: "Service metadata and health" },
    { name: "Events", description: "Generic Flowcore event ingestion" },
    { name: "Jobs", description: "Background jobs and state" },
    { name: "Flowcore", description: "Virtual pathway callbacks" },
    {
      name: "J-meldinger",
      description:
        "Read-only geo queries over Fiskeridir J-melding announcements (jmNumber, fragment key, GeoJSON, bbox)",
    },
  ],
  paths: {
    "/": {
      get: {
        tags: ["System"],
        summary: "API docs redirect",
        responses: {
          "302": { description: "Redirects to API docs" },
        },
      },
    },
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        responses: {
          "200": { description: "Service health" },
        },
      },
    },
    "/api/events": {
      post: {
        tags: ["Events"],
        summary: "Emit a generic Flowcore event",
        security: [{ FishfactsAuthToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GenericEventInput" },
            },
          },
        },
        responses: {
          "202": { description: "Event accepted by Flowcore" },
          "400": { description: "Invalid payload" },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": {
            description: "Flowcore write failed or auth upstream unavailable",
          },
        },
      },
    },
    "/api/events/{id}": {
      get: {
        tags: ["Events"],
        summary: "Read a projected generic event",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Projected event" },
          "401": { description: "Missing or invalid x-auth-token" },
          "404": { description: "Not found" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/transformer": {
      post: {
        tags: ["Flowcore"],
        summary: "Flowcore transformer webhook",
        responses: {
          "200": { description: "Event processed" },
          "401": { description: "Invalid transformer secret" },
        },
      },
    },
    "/api/jobs/cron": {
      post: {
        tags: ["Jobs"],
        summary: "Run scheduled jobs",
        description: "Starts due scheduled jobs and returns immediately.",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "202": {
            description: "Jobs started",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JobRunAllResponse" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/jobs/run": {
      post: {
        tags: ["Jobs"],
        summary: "Run one or all jobs",
        description:
          "Starts a background job run and returns current state without waiting for completion.",
        security: [{ FishfactsAuthToken: [] }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JobRunRequest" },
              examples: {
                all: {
                  summary: "Run all jobs",
                  value: {},
                },
                jmeldinger: {
                  summary: "Run J-meldinger",
                  value: {
                    jobId: "fiskeridir-jmeldinger",
                    args: {
                      maxItems: 25,
                      maxPages: 3,
                      refreshExisting: false,
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Job run started",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/JobRunSingleResponse" },
                    { $ref: "#/components/schemas/JobRunAllResponse" },
                  ],
                },
              },
            },
          },
          "400": { description: "Invalid payload" },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/jobs/state": {
      get: {
        tags: ["Jobs"],
        summary: "Read job state",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": {
            description: "Job state",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JobStateResponse" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/jobs/stop": {
      post: {
        tags: ["Jobs"],
        summary: "Stop a running job",
        security: [{ FishfactsAuthToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JobStopRequest" },
              examples: {
                jmeldinger: {
                  summary: "Stop J-meldinger",
                  value: { jobId: "fiskeridir-jmeldinger" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Stop request handled",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JobStopResponse" },
              },
            },
          },
          "400": { description: "Invalid payload" },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/reset": {
      post: {
        tags: ["Flowcore"],
        summary: "Virtual pathway reset callback",
        responses: {
          "200": { description: "Pump reset processed" },
          "401": { description: "Invalid reset secret" },
        },
      },
    },
    "/api/jmeldinger": {
      get: {
        tags: ["J-meldinger"],
        summary: "List J-melding geo records (or query by bbox / near)",
        description:
          "When `bbox` is provided, returns records whose extracted points intersect the bounding box. When `near` is provided, returns records within `radiusKm` of the point. Otherwise lists records with optional `status`, `hasGeo`, and `q` (jmNumber prefix) filters. `bbox` and `near` are mutually exclusive.",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["current", "archived", "unknown"],
            },
          },
          {
            name: "hasGeo",
            in: "query",
            schema: { type: "boolean" },
          },
          {
            name: "q",
            in: "query",
            description: "Case-insensitive prefix match against `jmNumber`.",
            schema: { type: "string" },
          },
          {
            name: "bbox",
            in: "query",
            description: "Bounding box `minLon,minLat,maxLon,maxLat` in WGS84.",
            schema: { type: "string", example: "24,70,32,72" },
          },
          {
            name: "near",
            in: "query",
            description: "Center point `lon,lat` in WGS84.",
            schema: { type: "string", example: "24.93,71.18" },
          },
          {
            name: "radiusKm",
            in: "query",
            description:
              "Radius in kilometers (used with `near`). Default 50, max 5000.",
            schema: { type: "number", minimum: 0, maximum: 5000, default: 50 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          {
            name: "cursor",
            in: "query",
            description:
              "Opaque pagination cursor returned by the previous page.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Page of J-melding geo summaries",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JMeldingGeoPage" },
              },
            },
          },
          "400": { description: "Invalid query parameters" },
          "401": { description: "Missing or invalid x-auth-token" },
        },
      },
    },
    "/api/jmeldinger/{jmNumber}": {
      get: {
        tags: ["J-meldinger"],
        summary: "Fetch a single J-melding geo record",
        description:
          "Accepts either the `jmNumber` (e.g. `j-67-2026`) or the Usable `fragmentKey` (e.g. `fishfacts-jmelding-j-67-2026`).",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "jmNumber",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Full J-melding geo record",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JMeldingGeoRecord" },
              },
            },
          },
          "404": { description: "Not found" },
          "401": { description: "Missing or invalid x-auth-token" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      FishfactsAuthToken: {
        type: "apiKey",
        in: "header",
        name: "x-auth-token",
        description:
          "Fishfacts session token issued by POST /api/v3/login on api.fishfacts.fo. The backend revalidates it against /api/v3/user/active on each cache miss.",
      },
    },
    schemas: {
      GenericEventInput: {
        type: "object",
        required: ["id", "kind"],
        properties: {
          id: { type: "string", format: "uuid" },
          kind: { type: "string", minLength: 1, maxLength: 100 },
          payload: {
            type: "object",
            additionalProperties: true,
            default: {},
          },
          metadata: {
            type: "object",
            additionalProperties: true,
            default: {},
          },
        },
      },
      JobRunRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: {
            type: "string",
            enum: ["fiskeridir-jmeldinger"],
            description: "Omit to start all registered jobs.",
          },
          args: { $ref: "#/components/schemas/FiskeridirJMeldingerArgs" },
        },
      },
      FiskeridirJMeldingerArgs: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxItems: {
            type: "integer",
            minimum: 1,
            description: "Max announcements to process in this run.",
          },
          maxPages: {
            type: "integer",
            minimum: 1,
            description: "Max listing pages to scan.",
          },
          includeArchived: {
            type: "boolean",
            default: false,
          },
          refreshExisting: {
            type: "boolean",
            default: false,
            description:
              "When false, existing Usable J-melding fragments are treated as already processed.",
          },
        },
      },
      JobStopRequest: {
        type: "object",
        required: ["jobId"],
        additionalProperties: false,
        properties: {
          jobId: {
            type: "string",
            enum: ["fiskeridir-jmeldinger"],
          },
        },
      },
      JobRunSingleResponse: {
        type: "object",
        required: ["ok", "mode", "jobId", "runId", "state", "runAt"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          mode: { type: "string", enum: ["single"] },
          jobId: { type: "string" },
          runId: { type: "string" },
          state: { $ref: "#/components/schemas/JobState" },
          runAt: { type: "string", format: "date-time" },
        },
      },
      JobRunAllResponse: {
        type: "object",
        required: ["ok", "mode", "results"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          mode: { type: "string", enum: ["all"] },
          trigger: { type: "string", enum: ["cron"] },
          runAt: { type: "string", format: "date-time" },
          results: {
            type: "array",
            items: { $ref: "#/components/schemas/JobStartResult" },
          },
        },
      },
      JobStartResult: {
        type: "object",
        required: ["jobId", "status"],
        properties: {
          jobId: { type: "string" },
          status: { type: "string", enum: ["started", "skipped", "error"] },
          runId: { type: "string" },
          fragmentId: { type: "string" },
          state: { $ref: "#/components/schemas/JobState" },
          error: { type: "string" },
        },
      },
      JobStateResponse: {
        type: "object",
        required: [
          "ok",
          "fragmentIds",
          "jobs",
          "runningJobIds",
          "state",
          "now",
        ],
        properties: {
          ok: { type: "boolean", enum: [true] },
          fragmentIds: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          jobs: {
            type: "array",
            items: { $ref: "#/components/schemas/JobDefinition" },
          },
          runningJobIds: {
            type: "array",
            items: { type: "string" },
          },
          state: {
            type: "object",
            additionalProperties: { $ref: "#/components/schemas/JobState" },
          },
          now: { type: "string", format: "date-time" },
        },
      },
      JobDefinition: {
        type: "object",
        required: ["id", "name", "schedule", "defaultArgs"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          schedule: { type: "string" },
          defaultArgs: {
            $ref: "#/components/schemas/FiskeridirJMeldingerArgs",
          },
        },
      },
      JobState: {
        type: "object",
        required: ["jobId", "status"],
        properties: {
          jobId: { type: "string" },
          status: {
            type: "string",
            enum: ["idle", "running", "success", "error", "stopping"],
          },
          runId: { type: "string" },
          startedAt: { type: "string", format: "date-time" },
          finishedAt: { type: "string", format: "date-time" },
          lastSuccessAt: { type: "string", format: "date-time" },
          lastError: { type: "string" },
          progress: { $ref: "#/components/schemas/JobProgress" },
          cursor: {
            type: "object",
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      JobProgress: {
        type: "object",
        properties: {
          scanned: { type: "integer" },
          emitted: { type: "integer" },
          skipped: { type: "integer" },
          total: { type: "integer" },
          percent: { type: "integer", minimum: 0, maximum: 100 },
          pagesProcessed: { type: "integer" },
          pagesTotal: { type: "integer" },
          itemsDiscovered: { type: "integer" },
          knownItems: { type: "integer" },
          skippedExisting: { type: "integer" },
          detailsProcessed: { type: "integer" },
          detailsTotal: { type: "integer" },
          message: { type: "string" },
        },
        additionalProperties: true,
      },
      JobStopResponse: {
        type: "object",
        required: ["ok", "jobId", "message"],
        properties: {
          ok: { type: "boolean", enum: [true] },
          jobId: { type: "string" },
          message: { type: "string" },
        },
      },
      JMeldingGeoListRow: {
        type: "object",
        required: [
          "jmNumber",
          "fragmentKey",
          "title",
          "status",
          "url",
          "hasGeo",
        ],
        properties: {
          jmNumber: { type: "string", example: "j-67-2026" },
          fragmentKey: {
            type: "string",
            example: "fishfacts-jmelding-j-67-2026",
          },
          fragmentId: {
            type: "string",
            format: "uuid",
            nullable: true,
            description: "Usable fragment id, when known.",
          },
          title: { type: "string" },
          status: {
            type: "string",
            enum: ["current", "archived", "unknown"],
          },
          url: { type: "string", format: "uri" },
          hasGeo: { type: "boolean" },
          bbox: {
            type: "array",
            nullable: true,
            description: "[minLon, minLat, maxLon, maxLat] in WGS84.",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4,
          },
        },
      },
      JMeldingGeoPage: {
        type: "object",
        required: ["rows", "nextCursor"],
        properties: {
          rows: {
            type: "array",
            items: { $ref: "#/components/schemas/JMeldingGeoListRow" },
          },
          nextCursor: { type: "string", nullable: true },
        },
      },
      JMeldingGeoRecord: {
        allOf: [
          { $ref: "#/components/schemas/JMeldingGeoListRow" },
          {
            type: "object",
            required: ["signature", "areas", "createdAt", "updatedAt"],
            properties: {
              signature: { type: "string" },
              areas: {
                type: "array",
                description:
                  "Named sub-areas, each with raw points. `name` may be null when no preceding heading was detected.",
                items: {
                  type: "object",
                  required: ["points"],
                  properties: {
                    name: { type: "string", nullable: true },
                    points: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["lat", "lon"],
                        properties: {
                          lat: { type: "number" },
                          lon: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
              geojson: {
                type: "object",
                nullable: true,
                description:
                  "GeoJSON FeatureCollection rendered from extracted points (one Feature per area). May be the stored projector output or computed via PostGIS ST_AsGeoJSON.",
                additionalProperties: true,
              },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        ],
      },
    },
  },
} as const;
