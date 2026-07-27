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
    {
      name: "Catch",
      description:
        "Read-only Sildelaget catch journal projections and FishFacts-compatible catch aggregates.",
    },
    { name: "Flowcore", description: "Virtual pathway callbacks" },
    {
      name: "J-meldinger",
      description:
        "Read-only geo queries over Fiskeridir J-melding announcements (jmNumber, fragment key, GeoJSON, bbox)",
    },
    {
      name: "Tiles",
      description:
        "Mapbox Vector Tile (MVT) endpoints. Tiles are produced server-side from PostGIS; layers are listed via /api/tiles/catalog.",
    },
    {
      name: "Areas",
      description:
        "Operator-curated areas (polygons / polylines). Reads are open to authenticated users; writes require the ADMIN authority.",
    },
    {
      name: "POI",
      description:
        "Point-of-Interest gazetteer (named lighthouses/landmarks used as narrative boundary vertices). Reads are public reference data; writes require the ADMIN authority and are event-sourced into editable Usable fragments.",
    },
    {
      name: "Reports",
      description:
        "In-chat issue reports: consented session captures from the FishFacts chat (chat log, parent tool calls, FE network requests) relayed into Usable Report fragments. Submission is open to any authenticated user; list/detail are ADMIN-only proxies over the Usable API.",
    },
    {
      name: "AIS",
      description:
        "Read-only AIS vessel position tracks from the ClickHouse read model. Supports multiple vessels and time-window filters (preset window or explicit from/to), server-side downsampled per vessel.",
    },
    {
      name: "AIS control",
      description:
        "Admin control of the AIS ingestion pipeline: enable forward-fill (live tail + pump from the cutover hour), start/pause/resume the historical backfill (which self-projects into ClickHouse), and inspect state.",
    },
    {
      name: "Docs",
      description: "OpenAPI document and rendered API reference",
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
          "200": {
            description: "Service health",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Docs"],
        summary: "OpenAPI 3.0 document",
        responses: {
          "200": {
            description: "OpenAPI document for this service",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/api/docs": {
      get: {
        tags: ["Docs"],
        summary: "OpenAPI 3.0 document (alias of /openapi.json)",
        responses: {
          "200": {
            description: "OpenAPI document for this service",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/docs": {
      get: {
        tags: ["Docs"],
        summary: "Rendered API reference (Scalar)",
        responses: {
          "200": {
            description: "HTML page rendering the OpenAPI document",
            content: { "text/html": {} },
          },
        },
      },
    },
    "/swagger": {
      get: {
        tags: ["Docs"],
        summary: "Rendered API reference (alias of /docs)",
        responses: {
          "200": {
            description: "HTML page rendering the OpenAPI document",
            content: { "text/html": {} },
          },
        },
      },
    },
    "/api/events": {
      post: {
        tags: ["Events"],
        summary: "Emit a generic Flowcore event (ADMIN authority required)",
        description: "Requires a valid FishFacts token with ADMIN authority.",
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
          "202": {
            description: "Event accepted by Flowcore",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EventAcceptedResponse" },
              },
            },
          },
          "400": {
            description: "Invalid payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidationError" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "502": {
            description: "Flowcore write failed or auth upstream unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
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
          "200": {
            description: "Projected event",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenericEventRecord" },
              },
            },
          },
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
        summary: "Run scheduled jobs (ADMIN authority required)",
        description:
          "Starts due scheduled jobs and returns immediately. Requires ADMIN authority.",
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
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/jobs/run": {
      post: {
        tags: ["Jobs"],
        summary: "Run one or all jobs (ADMIN authority required)",
        description:
          "Starts a background job run and returns current state without waiting for completion. Requires ADMIN authority. Manual Sildelaget backfills can set args.selectedTime to any positive hour count.",
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
                sildelaget: {
                  summary: "Run Sildelaget catch journal",
                  value: {
                    jobId: "sildelaget-catchjournal",
                    args: {
                      selectedTime: 168,
                      selectedSpecies: "",
                      selectedCatchType: "",
                      isNor: true,
                    },
                  },
                },
                sildelagetBackfill: {
                  summary: "Manual Sildelaget backfill and route import",
                  value: {
                    jobId: "sildelaget-catchjournal",
                    args: {
                      selectedTime: 8760,
                      selectedSpecies: "",
                      selectedCatchType: "",
                      isNor: true,
                      backfill: true,
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
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/jobs/state": {
      get: {
        tags: ["Jobs"],
        summary: "Read job state (ADMIN authority required)",
        description: "Requires ADMIN authority.",
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
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/jobs/stop": {
      post: {
        tags: ["Jobs"],
        summary: "Stop a running job (ADMIN authority required)",
        description: "Requires ADMIN authority.",
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
                sildelaget: {
                  summary: "Stop Sildelaget catch journal",
                  value: { jobId: "sildelaget-catchjournal" },
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
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
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
    "/api/catch": {
      get: {
        tags: ["Catch"],
        summary: "List FishFacts-compatible catch aggregates",
        description:
          "Aggregates projected Sildelaget catch journal lines by report date and species. Response shape matches the FishFacts vessel catch wrapper.",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date" },
            description:
              "Inclusive report date lower bound. Default today - 365 days.",
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date" },
            description: "Inclusive report date upper bound. Default today.",
          },
          {
            name: "species",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "vesselName",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "registrationMark",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "FishFacts-compatible catch wrapper",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FishfactsCatchWrapper" },
                examples: {
                  sample: {
                    value: {
                      code: 0,
                      errors: [],
                      message: "",
                      data: {
                        catches: [
                          {
                            date: "2026-05-28",
                            totalFullWeightKg: 12500,
                            totalGuttedWeightKg: 0,
                            totalWeightKg: 12500,
                            catches: [
                              {
                                specie: "NVG-sild",
                                fullWeightKg: 12500,
                                guttedWeightKg: 0,
                                weightKg: 12500,
                              },
                            ],
                          },
                        ],
                        locations: [
                          {
                            id: 2852,
                            latitude: 60.7476,
                            longitude: 2.5143,
                            speed: 0,
                            heading: 0,
                            lastUpdate: "2026-05-28T10:30:00.000Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid query parameters" },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/catch/full": {
      get: {
        tags: ["Catch"],
        summary: "List full Sildelaget catch entries",
        description:
          "Returns parent innmeldingsjournal entries with complete projected Sildelaget child lines.",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date" },
            description:
              "Inclusive report date lower bound. Default today - 365 days.",
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date" },
            description: "Inclusive report date upper bound. Default today.",
          },
          {
            name: "species",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "vesselName",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "registrationMark",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "innmeldingId",
            in: "query",
            schema: { type: "string" },
          },
          {
            name: "q",
            in: "query",
            description:
              "Case-insensitive search across innmelding id, vessel, registration mark, species, buyer, and receiver.",
            schema: { type: "string" },
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
            description: "Page of Sildelaget catch entries",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CatchFullPage" },
                examples: {
                  sample: {
                    value: {
                      rows: [
                        {
                          innmeldingId: "123456",
                          reportedDate: "2026-05-28",
                          reportedTime: "10:30:00",
                          vesselName: "Fiskebas",
                          registrationMark: "FO-123",
                          entryHash:
                            "8b1a9953c4611296a827abf8c47804d7f0f9d6f4b4ccf9a1b92d2bda8f6a3a9d",
                          sourceUrl:
                            "https://www.sildelaget.no/umbraco/api/catchjournal/ExportCatchJournal?selectedTime=168&selectedSpecies=&selectedCatchType=&isNor=true",
                          checkedAt: "2026-05-28T10:35:00.000Z",
                          rawEntry: {},
                          sourceEventId: "evt_123",
                          createdAt: "2026-05-28T10:36:00.000Z",
                          updatedAt: "2026-05-28T10:36:00.000Z",
                          lines: [
                            {
                              lineKey:
                                "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7c7b3e69b2c5c4b",
                              innmeldingId: "123456",
                              lineIndex: 0,
                              fishingStartDate: "2026-05-27",
                              fishingStartTime: "22:00:00",
                              species: "NVG-sild",
                              tonnes: 12.5,
                              weightKg: 12500,
                              average: 325,
                              catchType: "Direkte",
                              salesType: "Auksjon",
                              gear: "Not",
                              route: "5",
                              routeKey: "#0005",
                              routeFaoArea: "27.4.A",
                              routeCenterLatitude: 60.5,
                              routeCenterLongitude: 2.5,
                              routeCoordinates: [
                                { latitude: 60, longitude: 2 },
                                { latitude: 61, longitude: 2 },
                              ],
                              use: "Konsum",
                              buyer: "Buyer AS",
                              receiver: "Receiver AS",
                            },
                          ],
                        },
                      ],
                      nextCursor: null,
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid query parameters" },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/ais/tracks": {
      get: {
        tags: ["AIS"],
        summary: "Vessel position tracks (multi-vessel)",
        description:
          "Returns AIS position tracks for one or more vessels over a time window, from the ClickHouse read model. Provide a preset `window` (6h…90d) or explicit `from`/`to`. Each vessel's points are downsampled server-side to ~`maxPointsPerVessel` (latest fix per time bucket) and returned ascending by time; `last` is the most recent fix (heading/speed for the map label).",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "vesselIds",
            in: "query",
            required: true,
            schema: { type: "string" },
            description:
              "Comma-separated vessel ids (location.vessel_id). Max 50 per request.",
            example: "932,6264,1529",
          },
          {
            name: "window",
            in: "query",
            schema: {
              type: "string",
              enum: ["6h", "24h", "3d", "7d", "14d", "30d", "90d"],
            },
            description:
              "Preset time window ending now. Mutually exclusive with from/to. Defaults to 24h when neither window nor from/to is given.",
          },
          {
            name: "from",
            in: "query",
            schema: { type: "string", format: "date-time" },
            description: "Inclusive lower bound (ISO-8601). Requires `to`.",
          },
          {
            name: "to",
            in: "query",
            schema: { type: "string", format: "date-time" },
            description: "Exclusive upper bound (ISO-8601). Requires `from`.",
          },
          {
            name: "maxPointsPerVessel",
            in: "query",
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 50000,
              default: 2000,
            },
            description:
              "Cap on downsampled points returned per vessel (even time-bucket sampling).",
          },
          {
            name: "status",
            in: "query",
            schema: { type: "string" },
            description:
              "Optional comma-separated AIS status filter (e.g. 'Engaged in Fishing'). Use for the map's fishing-activity filter.",
          },
        ],
        responses: {
          "200": {
            description: "Per-vessel downsampled tracks",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AisTracksResponse" },
                examples: {
                  sample: {
                    value: {
                      from: "2026-06-13T10:00:00.000Z",
                      to: "2026-06-16T10:00:00.000Z",
                      vessels: [
                        {
                          vesselId: 932,
                          pointCount: 2,
                          last: {
                            t: "2026-06-16T09:58:18.000Z",
                            lat: 62.16043,
                            lon: -6.78112,
                            speed: 2.6,
                            heading: 126,
                            course: null,
                            status: "Engaged in Fishing",
                          },
                          points: [
                            {
                              t: "2026-06-16T08:00:00.000Z",
                              lat: 62.1,
                              lon: -6.8,
                              speed: 0,
                              heading: 90,
                              course: null,
                              status: "At anchor",
                            },
                            {
                              t: "2026-06-16T09:58:18.000Z",
                              lat: 62.16043,
                              lon: -6.78112,
                              speed: 2.6,
                              heading: 126,
                              course: null,
                              status: "Engaged in Fishing",
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid query parameters" },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": { description: "Auth upstream unavailable" },
        },
      },
    },
    "/api/ais/enable": {
      post: {
        tags: ["AIS control"],
        summary: "Enable forward-fill + set the backfill cutover (ADMIN)",
        description:
          "Captures the cutover boundary T0 (current hour, floored), records the oldest source event time as the backfill start, and pins the live pump cursor to T0 so it projects live immediately. The live tail (cron) then forward-fills [T0, ∞). Call POST /api/ais/resume to start the historical backfill of [oldest, T0). Requires ADMIN authority.",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": {
            description: "Forward-fill enabled; cutover + pump pin set",
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": { description: "Caller lacks the ADMIN authority" },
        },
      },
    },
    "/api/ais/resume": {
      post: {
        tags: ["AIS control"],
        summary: "Start/resume the historical backfill (ADMIN)",
        description:
          "Sets the durable backfill_enabled flag; the in-process supervisor (re)starts the backfill within ~60s, resuming from saved per-bucket state and self-projecting each hour-bucket into ClickHouse newest-first. Requires POST /api/ais/enable first. Requires ADMIN authority.",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": { description: "Backfill enabled" },
          "400": { description: "enable not called yet" },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": { description: "Caller lacks the ADMIN authority" },
        },
      },
    },
    "/api/ais/pause": {
      post: {
        tags: ["AIS control"],
        summary: "Pause the historical backfill (ADMIN)",
        description:
          "Clears backfill_enabled (durable) and requests stop of any running backfill. Forward-fill (live tail + pump) is unaffected. Resume with POST /api/ais/resume. Requires ADMIN authority.",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": { description: "Backfill paused" },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": { description: "Caller lacks the ADMIN authority" },
        },
      },
    },
    "/api/ais/state": {
      get: {
        tags: ["AIS control"],
        summary: "AIS pipeline control + progress (ADMIN)",
        description:
          "Returns the control config (cutover, backfill start, enabled flag), backfill bucket counts by status, total ClickHouse rows (pre-merge), and whether a backfill run is in flight. Requires ADMIN authority.",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": { description: "Current AIS pipeline state" },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": { description: "Caller lacks the ADMIN authority" },
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
    "/api/tiles/catalog": {
      get: {
        tags: ["Tiles"],
        summary: "List available MVT layers",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": {
            description: "Tile catalog",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TileCatalogResponse" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
        },
      },
    },
    "/api/tiles/{layer}/{z}/{x}/{y}.pbf": {
      get: {
        tags: ["Tiles"],
        summary: "Fetch a Mapbox Vector Tile for a layer",
        description:
          "Returns a Mapbox Vector Tile (MVT) protobuf for the given layer and XYZ tile coordinates. Returns `204 No Content` when the tile is empty.",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "layer",
            in: "path",
            required: true,
            description: "Layer id from /api/tiles/catalog.",
            schema: { type: "string", example: "jmelding-closures" },
          },
          {
            name: "z",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 0, maximum: 22 },
          },
          {
            name: "x",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "y",
            in: "path",
            required: true,
            description:
              "Tile Y coordinate. The `.pbf` extension is part of the URL.",
            schema: { type: "integer", minimum: 0 },
          },
        ],
        responses: {
          "200": {
            description: "MVT protobuf",
            content: {
              "application/vnd.mapbox-vector-tile": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "204": { description: "Empty tile" },
          "400": {
            description: "Invalid tile coordinates",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "404": {
            description: "Unknown tile layer",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UnknownLayerError" },
              },
            },
          },
          "500": {
            description: "Tile generation failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/areas": {
      get: {
        tags: ["Areas"],
        summary: "List active areas",
        security: [{ FishfactsAuthToken: [] }],
        responses: {
          "200": {
            description: "Active areas (soft-deleted entries excluded)",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AreaListResponse",
                },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
        },
      },
      post: {
        tags: ["Areas"],
        summary: "Create an area (ADMIN authority required)",
        description:
          "Emits a `fishfacts-areas.0/area.created.0` Flowcore event. The projection becomes visible via GET once the pump applies it.",
        security: [{ FishfactsAuthToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AreaCreateInput" },
            },
          },
        },
        responses: {
          "202": {
            description: "Area creation event accepted by Flowcore",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AreaWriteResponse",
                },
              },
            },
          },
          "400": {
            description: "Invalid payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidationError" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "502": {
            description: "Flowcore write failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/poi": {
      get: {
        tags: ["POI"],
        summary: "List the Point-of-Interest gazetteer",
        description:
          "Public reference data. Served from the editable Usable POI fragments through a short in-process cache; the FE resolves landmark names against these entries by exact key / exact alias only.",
        responses: {
          "200": {
            description: "Gazetteer entries",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PoiListResponse" },
              },
            },
          },
          "503": {
            description: "Gazetteer source unavailable and no cached snapshot",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      post: {
        tags: ["POI"],
        summary: "Teach the gazetteer a POI (ADMIN authority required)",
        description:
          "Emits a `fishfacts-poi.0/poi.created.0` Flowcore event; a projector upserts the POI fragment in Usable (by key) with `verifiedBy`/`verifiedAt` stamped server-side from the authenticated admin. Deleting the fragment reverts resolution of the name to the fail-safe ask.",
        security: [{ FishfactsAuthToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PoiCreateInput" },
            },
          },
        },
        responses: {
          "202": {
            description: "POI creation event accepted by Flowcore",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PoiWriteResponse" },
              },
            },
          },
          "400": {
            description: "Invalid payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidationError" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "502": {
            description: "Flowcore write failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/reports": {
      post: {
        tags: ["Reports"],
        summary: "Submit an in-chat issue report",
        description:
          "Receives the consented session capture from the FishFacts chat UI (chat log, parent tool calls, FE network requests), stamps the reporter server-side from the auth token, truncates oversized captures instead of rejecting them, and creates a Usable Report fragment (`status: reported`).",
        security: [{ FishfactsAuthToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReportSubmission" },
            },
          },
        },
        responses: {
          "201": {
            description: "Report fragment created in Usable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReportSubmitResponse" },
              },
            },
          },
          "400": {
            description: "Invalid payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidationError" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "502": {
            description: "Usable write failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "503": {
            description: "Reports feature not configured",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      get: {
        tags: ["Reports"],
        summary: "List issue reports (ADMIN authority required)",
        description:
          "Proxies the Usable Report fragment list — the FE never talks to the Usable API directly. Newest first; optional `status` filter on the report lifecycle (reported | triaged | reproducing | fixed | wontfix | closed).",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Filter by lifecycle status, e.g. `reported`.",
          },
        ],
        responses: {
          "200": {
            description: "Report list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReportListResponse" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "503": {
            description: "Usable unavailable or reports not configured",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/reports/{id}": {
      get: {
        tags: ["Reports"],
        summary: "Fetch one issue report (ADMIN authority required)",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Usable fragment id returned by list/submit.",
          },
        ],
        responses: {
          "200": {
            description: "Full report incl. the raw capture content",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReportDetail" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "404": { description: "Unknown report id" },
          "503": {
            description: "Usable unavailable or reports not configured",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/areas/{id}": {
      get: {
        tags: ["Areas"],
        summary: "Fetch a single area",
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
          "200": {
            description: "Area record",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AreaRecord" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "404": { description: "Not found" },
        },
      },
      put: {
        tags: ["Areas"],
        summary: "Update an area (ADMIN authority required)",
        description:
          "Emits a `fishfacts-areas.0/area.updated.0` Flowcore event. The patch must include at least one field.",
        security: [{ FishfactsAuthToken: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AreaUpdateInput" },
            },
          },
        },
        responses: {
          "202": {
            description: "Area update event accepted by Flowcore",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AreaWriteResponse",
                },
              },
            },
          },
          "400": {
            description: "Invalid payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidationError" },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "404": { description: "Not found" },
          "502": {
            description: "Flowcore write failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Areas"],
        summary: "Soft-delete an area (ADMIN authority required)",
        description:
          "Emits a `fishfacts-areas.0/area.deleted.0` Flowcore event. The projection marks the row deleted but does not physically remove it.",
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
          "202": {
            description: "Area deletion event accepted by Flowcore",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AreaWriteResponse",
                },
              },
            },
          },
          "401": { description: "Missing or invalid x-auth-token" },
          "403": {
            description: "Caller lacks the ADMIN authority",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ForbiddenError" },
              },
            },
          },
          "404": { description: "Not found" },
          "502": {
            description: "Flowcore write failed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
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
            enum: ["fiskeridir-jmeldinger", "sildelaget-catchjournal"],
            description: "Omit to start all registered jobs.",
          },
          args: {
            oneOf: [
              { $ref: "#/components/schemas/FiskeridirJMeldingerArgs" },
              { $ref: "#/components/schemas/SildelagetCatchJournalArgs" },
            ],
          },
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
      SildelagetCatchJournalArgs: {
        type: "object",
        additionalProperties: false,
        properties: {
          selectedTime: {
            type: "integer",
            minimum: 1,
            default: 168,
            example: 8760,
            description:
              "Manual backfill duration in hours. Cron default is 168; use any positive integer, e.g. 8760 for one year.",
          },
          selectedSpecies: {
            type: "string",
            default: "",
          },
          selectedCatchType: {
            type: "string",
            default: "",
          },
          isNor: {
            type: "boolean",
            default: true,
          },
          backfill: {
            type: "boolean",
            default: false,
            description:
              "When true, emits all parsed entries for the selected duration so existing rows can be reimported with route metadata.",
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
            enum: ["fiskeridir-jmeldinger", "sildelaget-catchjournal"],
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
            oneOf: [
              { $ref: "#/components/schemas/FiskeridirJMeldingerArgs" },
              { $ref: "#/components/schemas/SildelagetCatchJournalArgs" },
            ],
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
      FishfactsCatchWrapper: {
        type: "object",
        required: ["code", "errors", "message", "data"],
        properties: {
          code: { type: "integer", enum: [0] },
          errors: {
            type: "array",
            items: {},
            maxItems: 0,
          },
          message: { type: "string", enum: [""] },
          data: {
            type: "object",
            required: ["catches", "locations"],
            properties: {
              catches: {
                type: "array",
                items: { $ref: "#/components/schemas/DayCatchResponse" },
              },
              locations: {
                type: "array",
                items: {
                  $ref: "#/components/schemas/VesselLocationResponse",
                },
              },
            },
          },
        },
      },
      VesselLocationResponse: {
        type: "object",
        required: [
          "id",
          "latitude",
          "longitude",
          "speed",
          "heading",
          "lastUpdate",
        ],
        properties: {
          id: { type: "integer", format: "int64" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          speed: { type: "number" },
          heading: { type: "number" },
          lastUpdate: { type: "string", format: "date-time" },
        },
      },
      DayCatchResponse: {
        type: "object",
        required: [
          "date",
          "totalFullWeightKg",
          "totalGuttedWeightKg",
          "totalWeightKg",
          "catches",
        ],
        properties: {
          date: { type: "string", format: "date" },
          totalFullWeightKg: { type: "number" },
          totalGuttedWeightKg: { type: "number" },
          totalWeightKg: { type: "number" },
          catches: {
            type: "array",
            items: { $ref: "#/components/schemas/CatchResponse" },
          },
        },
      },
      CatchResponse: {
        type: "object",
        required: ["specie", "fullWeightKg", "guttedWeightKg", "weightKg"],
        properties: {
          specie: { type: "string" },
          fullWeightKg: { type: "number" },
          guttedWeightKg: { type: "number" },
          weightKg: { type: "number" },
        },
      },
      SildelagetCatchEntry: {
        type: "object",
        required: [
          "innmeldingId",
          "reportedDate",
          "reportedTime",
          "vesselName",
          "registrationMark",
          "entryHash",
          "sourceUrl",
          "checkedAt",
          "rawEntry",
          "sourceEventId",
          "createdAt",
          "updatedAt",
          "lines",
        ],
        properties: {
          innmeldingId: { type: "string" },
          reportedDate: { type: "string", format: "date", nullable: true },
          reportedTime: { type: "string", nullable: true },
          vesselName: { type: "string", nullable: true },
          registrationMark: { type: "string", nullable: true },
          entryHash: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          sourceUrl: { type: "string", format: "uri" },
          checkedAt: { type: "string", format: "date-time" },
          rawEntry: { type: "object", additionalProperties: true },
          sourceEventId: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          lines: {
            type: "array",
            items: { $ref: "#/components/schemas/SildelagetCatchLine" },
          },
        },
      },
      SildelagetCatchLine: {
        type: "object",
        required: [
          "lineKey",
          "innmeldingId",
          "lineIndex",
          "rawRow",
          "sourceEventId",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          lineKey: { type: "string", pattern: "^[a-f0-9]{64}$" },
          innmeldingId: { type: "string" },
          lineIndex: { type: "integer" },
          fishingStartDate: {
            type: "string",
            format: "date",
            nullable: true,
          },
          fishingStartTime: { type: "string", nullable: true },
          species: { type: "string", nullable: true },
          tonnes: { type: "number", nullable: true },
          weightKg: { type: "number", nullable: true },
          average: { type: "number", nullable: true },
          catchType: { type: "string", nullable: true },
          salesType: { type: "string", nullable: true },
          gear: { type: "string", nullable: true },
          route: { type: "string", nullable: true },
          routeKey: {
            type: "string",
            nullable: true,
            description:
              "Normalized Sildelaget catch-map route key, e.g. #0855.",
          },
          routeFaoArea: { type: "string", nullable: true },
          routeCenterLatitude: { type: "number", nullable: true },
          routeCenterLongitude: { type: "number", nullable: true },
          routeCoordinates: {
            type: "array",
            nullable: true,
            items: {
              type: "object",
              required: ["latitude", "longitude"],
              properties: {
                latitude: { type: "number" },
                longitude: { type: "number" },
              },
            },
          },
          use: { type: "string", nullable: true },
          pct1: { type: "number", nullable: true },
          pct2: { type: "number", nullable: true },
          pct3: { type: "number", nullable: true },
          pct4: { type: "number", nullable: true },
          assortment: { type: "string", nullable: true },
          offerEastSouth: { type: "string", nullable: true },
          offerEastSouthDate: {
            type: "string",
            format: "date",
            nullable: true,
          },
          offerEastSouthTime: { type: "string", nullable: true },
          offerEastNorth: { type: "string", nullable: true },
          offerEastNorthDate: {
            type: "string",
            format: "date",
            nullable: true,
          },
          offerEastNorthTime: { type: "string", nullable: true },
          offerWestSouth: { type: "string", nullable: true },
          offerWestSouthDate: {
            type: "string",
            format: "date",
            nullable: true,
          },
          offerWestSouthTime: { type: "string", nullable: true },
          offerWestNorth: { type: "string", nullable: true },
          offerWestNorthDate: {
            type: "string",
            format: "date",
            nullable: true,
          },
          offerWestNorthTime: { type: "string", nullable: true },
          leasedVessel: { type: "string", nullable: true },
          economicZone: { type: "string", nullable: true },
          municipality: { type: "string", nullable: true },
          coFisher: { type: "string", nullable: true },
          buyer: { type: "string", nullable: true },
          receiver: { type: "string", nullable: true },
          nationality: { type: "string", nullable: true },
          rawRow: { type: "object", additionalProperties: true },
          sourceEventId: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CatchFullPage: {
        type: "object",
        required: ["rows", "nextCursor"],
        properties: {
          rows: {
            type: "array",
            items: { $ref: "#/components/schemas/SildelagetCatchEntry" },
          },
          nextCursor: { type: "string", nullable: true },
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
      HealthResponse: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", enum: [true] } },
      },
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          message: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: true,
      },
      ValidationError: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", enum: ["invalid_payload"] },
          issues: {
            type: "array",
            description: "Zod issue list when validation fails.",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
      ForbiddenError: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", enum: ["forbidden"] },
          reason: { type: "string", enum: ["admin_required"] },
        },
      },
      UnknownLayerError: {
        type: "object",
        required: ["error", "layer"],
        properties: {
          error: { type: "string", enum: ["unknown_layer"] },
          layer: { type: "string" },
        },
      },
      EventAcceptedResponse: {
        type: "object",
        required: ["eventId"],
        properties: {
          eventId: {
            type: "string",
            description: "Flowcore event id assigned to the ingested event.",
          },
        },
      },
      GenericEventRecord: {
        type: "object",
        required: [
          "id",
          "kind",
          "payload",
          "metadata",
          "sourceEventId",
          "validTime",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          kind: { type: "string" },
          payload: { type: "object", additionalProperties: true },
          metadata: { type: "object", additionalProperties: true },
          sourceEventId: {
            type: "string",
            description: "Flowcore event id that produced this projection.",
          },
          validTime: { type: "string", format: "date-time" },
        },
      },
      TileLayerKind: {
        type: "string",
        enum: ["polygon", "line", "point", "point-heatmap"],
      },
      TileLayer: {
        type: "object",
        required: ["id", "kind", "description", "attributes"],
        properties: {
          id: { type: "string", example: "jmelding-closures" },
          kind: { $ref: "#/components/schemas/TileLayerKind" },
          description: { type: "string" },
          attributes: {
            type: "array",
            description:
              "MVT feature property names emitted by this layer in addition to the geometry.",
            items: { type: "string" },
          },
        },
      },
      TileCatalogResponse: {
        type: "object",
        required: ["layers"],
        properties: {
          layers: {
            type: "array",
            items: { $ref: "#/components/schemas/TileLayer" },
          },
        },
      },
      AreaGeometryType: {
        type: "string",
        enum: ["polygon", "polyline"],
      },
      AreaGeometryPolygon: {
        type: "object",
        required: ["type", "coordinates"],
        properties: {
          type: { type: "string", enum: ["Polygon"] },
          coordinates: {
            type: "array",
            description:
              "GeoJSON Polygon coordinates: array of linear rings, each an array of [lon, lat] pairs.",
            items: {
              type: "array",
              items: {
                type: "array",
                items: { type: "number" },
                minItems: 2,
                maxItems: 2,
              },
            },
          },
        },
      },
      AreaGeometryLineString: {
        type: "object",
        required: ["type", "coordinates"],
        properties: {
          type: { type: "string", enum: ["LineString"] },
          coordinates: {
            type: "array",
            description:
              "GeoJSON LineString coordinates: array of [lon, lat] pairs.",
            items: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
            },
          },
        },
      },
      AreaGeometry: {
        oneOf: [
          { $ref: "#/components/schemas/AreaGeometryPolygon" },
          { $ref: "#/components/schemas/AreaGeometryLineString" },
        ],
        discriminator: {
          propertyName: "type",
          mapping: {
            Polygon: "#/components/schemas/AreaGeometryPolygon",
            LineString: "#/components/schemas/AreaGeometryLineString",
          },
        },
      },
      AreaRecord: {
        type: "object",
        required: [
          "id",
          "name",
          "groupName",
          "geometryType",
          "geometry",
          "color",
          "notes",
          "createdBy",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          groupName: { type: "string" },
          geometryType: { $ref: "#/components/schemas/AreaGeometryType" },
          geometry: { $ref: "#/components/schemas/AreaGeometry" },
          color: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          createdBy: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      AreaListResponse: {
        type: "object",
        required: ["rows"],
        properties: {
          rows: {
            type: "array",
            items: { $ref: "#/components/schemas/AreaRecord" },
          },
        },
      },
      AreaCreateInput: {
        type: "object",
        required: ["name", "groupName", "geometryType", "geometry"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          groupName: { type: "string", minLength: 1, maxLength: 80 },
          geometryType: { $ref: "#/components/schemas/AreaGeometryType" },
          geometry: { $ref: "#/components/schemas/AreaGeometry" },
          color: { type: "string", minLength: 1, maxLength: 32 },
          notes: { type: "string", maxLength: 2000 },
        },
      },
      AreaUpdateInput: {
        type: "object",
        minProperties: 1,
        additionalProperties: false,
        description:
          "Partial update. At least one property must be present. `color` and `notes` may be set to null to clear them.",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          groupName: { type: "string", minLength: 1, maxLength: 80 },
          geometryType: { $ref: "#/components/schemas/AreaGeometryType" },
          geometry: { $ref: "#/components/schemas/AreaGeometry" },
          color: {
            type: "string",
            nullable: true,
            minLength: 1,
            maxLength: 32,
          },
          notes: { type: "string", nullable: true, maxLength: 2000 },
        },
      },
      AreaWriteResponse: {
        type: "object",
        required: ["areaId", "eventId"],
        properties: {
          areaId: { type: "string", format: "uuid" },
          eventId: {
            type: "string",
            description:
              "Flowcore event id for the create/update/delete event emitted by this request.",
          },
        },
      },
      PoiEntry: {
        type: "object",
        required: ["key", "lat", "lng"],
        properties: {
          key: {
            type: "string",
            pattern: "^[a-z0-9_]+$",
            description: "Stable snake_case resolver key, e.g. hanstholm_fyr.",
          },
          lat: { type: "number", minimum: -90, maximum: 90 },
          lng: { type: "number", minimum: -180, maximum: 180 },
          title: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
      },
      PoiListResponse: {
        type: "object",
        required: ["pois", "returned"],
        properties: {
          pois: {
            type: "array",
            items: { $ref: "#/components/schemas/PoiEntry" },
          },
          returned: { type: "integer" },
        },
      },
      PoiCreateInput: {
        type: "object",
        required: ["key", "title", "lat", "lng", "source"],
        additionalProperties: false,
        description:
          "verifiedBy/verifiedAt are NOT accepted — attribution is stamped server-side from the authenticated admin.",
        properties: {
          key: {
            type: "string",
            pattern: "^[a-z0-9_]+$",
            minLength: 1,
            maxLength: 80,
          },
          title: { type: "string", minLength: 1, maxLength: 120 },
          lat: { type: "number", minimum: -90, maximum: 90 },
          lng: { type: "number", minimum: -180, maximum: 180 },
          aliases: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 120 },
          },
          source: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description:
              "Where the coordinate comes from (official register reference, or who supplied it in chat).",
          },
        },
      },
      PoiWriteResponse: {
        type: "object",
        required: ["key", "eventId", "verifiedAt"],
        properties: {
          key: { type: "string" },
          eventId: {
            type: "string",
            description: "Flowcore event id for the emitted poi.created event.",
          },
          verifiedAt: { type: "string", format: "date-time" },
        },
      },
      ReportSubmission: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          userDescription: {
            type: "string",
            description: "Optional 'What went wrong?' text from the user.",
          },
          contactEmail: {
            type: "string",
            format: "email",
            description:
              "Optional follow-up email (fallback — FishFacts tokens don't expose an email).",
          },
          appVersion: { type: "string" },
          userAgent: { type: "string" },
          viewport: {
            type: "object",
            properties: {
              width: { type: "integer" },
              height: { type: "integer" },
            },
          },
          capturedAt: { type: "string", format: "date-time" },
          messages: {
            type: "array",
            description: "Chat log, oldest first.",
            items: {
              type: "object",
              required: ["role", "content"],
              properties: {
                id: { type: "string" },
                role: { type: "string" },
                content: { type: "string" },
                createdAt: { type: "string" },
              },
            },
          },
          toolCalls: {
            type: "array",
            description: "Parent tool calls (TOOL_CALL/TOOL_RESPONSE).",
            items: {
              type: "object",
              required: ["tool"],
              properties: {
                tool: { type: "string" },
                args: {},
                result: {},
                error: { type: "string" },
                calledAt: { type: "string" },
                durationMs: { type: "number" },
              },
            },
          },
          networkRequests: {
            type: "array",
            description: "FE-originated fetches (FE-visible scope only).",
            items: {
              type: "object",
              required: ["method", "url"],
              properties: {
                method: { type: "string" },
                url: { type: "string" },
                status: { type: "integer" },
                ok: { type: "boolean" },
                error: { type: "string" },
                startedAt: { type: "string" },
                durationMs: { type: "number" },
              },
            },
          },
        },
      },
      ReportSubmitResponse: {
        type: "object",
        required: ["reportId", "fragmentId", "status"],
        properties: {
          reportId: { type: "string", format: "uuid" },
          fragmentId: {
            type: "string",
            description: "Usable fragment id of the created report.",
          },
          status: { type: "string", enum: ["reported"] },
        },
      },
      ReportListItem: {
        type: "object",
        required: ["id", "title", "status", "reporter"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string" },
          reportedAt: { type: "string", format: "date-time" },
          sessionId: { type: "string" },
          reporter: {
            type: "object",
            description: "Server-verified identity from the auth token.",
            properties: {
              fishfactsUserId: { type: "integer" },
              username: { type: "string" },
            },
          },
          contactEmail: {
            type: "string",
            description:
              "User-supplied follow-up address — NOT a verified identity field.",
          },
          appVersion: { type: "string" },
          capturedMessageCount: { type: "integer" },
          capturedToolCallCount: { type: "integer" },
          capturedNetworkRequestCount: { type: "integer" },
          truncated: { type: "boolean" },
        },
      },
      ReportListResponse: {
        type: "object",
        required: ["reports", "returned"],
        properties: {
          reports: {
            type: "array",
            items: { $ref: "#/components/schemas/ReportListItem" },
          },
          returned: { type: "integer" },
        },
      },
      ReportDetail: {
        allOf: [
          { $ref: "#/components/schemas/ReportListItem" },
          {
            type: "object",
            required: ["content"],
            properties: {
              content: {
                type: "string",
                description:
                  "Full report fragment markdown (frontmatter + chat log + tool calls + network requests).",
              },
            },
          },
        ],
      },
      AisTrackPoint: {
        type: "object",
        required: ["t", "lat", "lon", "speed", "heading", "course", "status"],
        properties: {
          t: {
            type: "string",
            format: "date-time",
            description: "AIS event time (UTC).",
          },
          lat: { type: "number" },
          lon: { type: "number" },
          speed: {
            type: "number",
            nullable: true,
            description: "Speed over ground (knots).",
          },
          heading: { type: "number", nullable: true },
          course: { type: "number", nullable: true },
          status: { type: "string", nullable: true },
        },
      },
      AisVesselTrack: {
        type: "object",
        required: ["vesselId", "pointCount", "last", "points"],
        properties: {
          vesselId: { type: "integer" },
          pointCount: { type: "integer" },
          last: {
            description: "Most recent fix in the window (null if none).",
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/AisTrackPoint" }],
          },
          points: {
            type: "array",
            description: "Downsampled fixes, ascending by time.",
            items: { $ref: "#/components/schemas/AisTrackPoint" },
          },
        },
      },
      AisTracksResponse: {
        type: "object",
        required: ["from", "to", "vessels"],
        properties: {
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
          vessels: {
            type: "array",
            description: "One entry per requested vessel (order preserved).",
            items: { $ref: "#/components/schemas/AisVesselTrack" },
          },
        },
      },
    },
  },
} as const;
