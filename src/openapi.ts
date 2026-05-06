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
    },
  },
} as const;
