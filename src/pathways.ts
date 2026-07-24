import {
  PathwayRouter,
  PathwaysBuilder,
  createNodeTransport,
  createPostgresPathwayCoordinator,
  createPostgresPumpStateManagerFactory,
} from "@flowcore/pathways";
import type { z } from "zod";
import type { AisPositionProjector } from "./ais/projector";
import type { AreasProjector } from "./areas/projector";
import type { Env } from "./env";
import {
  AIS_FLOW_TYPE,
  AIS_POSITION_FIX_OBSERVED_EVENT_TYPE,
  AIS_POSITION_FIX_OBSERVED_PATHWAY,
  ANNOUNCEMENT_FLOW_TYPE,
  AREA_CREATED_EVENT_TYPE,
  AREA_CREATED_PATHWAY,
  AREA_DELETED_EVENT_TYPE,
  AREA_DELETED_PATHWAY,
  AREA_FLOW_TYPE,
  AREA_UPDATED_EVENT_TYPE,
  AREA_UPDATED_PATHWAY,
  type AisPositionFixObserved,
  type AreaCreated,
  type AreaDeleted,
  type AreaUpdated,
  GEBCO_FEATURE_OBSERVED_EVENT_TYPE,
  GEBCO_FEATURE_OBSERVED_PATHWAY,
  GEBCO_FLOW_TYPE,
  GENERIC_EVENT_TYPE,
  GENERIC_FLOW_TYPE,
  GENERIC_PATHWAY,
  GILLNET_FLOW_TYPE,
  GILLNET_VESSEL_OBSERVED_EVENT_TYPE,
  GILLNET_VESSEL_OBSERVED_PATHWAY,
  type GebcoFeatureObserved,
  type GillnetVesselObserved,
  JMELDING_ANNOUNCEMENT_DISCOVERED_EVENT_TYPE,
  JMELDING_ANNOUNCEMENT_PATHWAY,
  type JMeldingAnnouncementDiscovered,
  POI_CREATED_EVENT_TYPE,
  POI_CREATED_PATHWAY,
  POI_FLOW_TYPE,
  type PoiCreated,
  SILDELAGET_CATCHJOURNAL_FLOW_TYPE,
  SILDELAGET_CATCH_ENTRY_OBSERVED_EVENT_TYPE,
  SILDELAGET_CATCH_ENTRY_OBSERVED_PATHWAY,
  type SildelagetCatchEntryObserved,
  aisPositionFixObservedSchema,
  areaCreatedSchema,
  areaDeletedSchema,
  areaUpdatedSchema,
  gebcoFeatureObservedSchema,
  genericEventInputSchema,
  gillnetVesselObservedSchema,
  jmeldingAnnouncementDiscoveredSchema,
  poiCreatedSchema,
  sildelagetCatchEntryObservedSchema,
} from "./events/contracts";
import { chunkAnnouncement } from "./events/jmelding-chunking";
import type { GenericEventRepository } from "./events/repository";
import type { GebcoProjector } from "./gebco/projector";
import type { GillnetProjector } from "./gillnet/projector";
import type { JMeldingChunkAssembler } from "./jobs/jmelding-chunk-assembler";
import type { PoiFragmentProjector } from "./poi/fragment-projector";
import type { SildelagetCatchProjector } from "./sildelaget/projector";

export interface PathwayWriter {
  writeGeneric(data: z.infer<typeof genericEventInputSchema>): Promise<string>;
  writeJMeldingAnnouncement(
    data: JMeldingAnnouncementDiscovered,
  ): Promise<string>;
  writeSildelagetCatchEntryObserved(
    data: SildelagetCatchEntryObserved,
  ): Promise<string>;
  writeGillnetVesselObserved(data: GillnetVesselObserved): Promise<string>;
  writeGebcoFeatureObserved(data: GebcoFeatureObserved): Promise<string>;
  writeAreaCreated(data: AreaCreated): Promise<string>;
  writeAreaUpdated(data: AreaUpdated): Promise<string>;
  writeAreaDeleted(data: AreaDeleted): Promise<string>;
  writePoiCreated(data: PoiCreated): Promise<string>;
  /**
   * Emit one AIS position fix. `opts.eventTime` is set by the BACKFILL job
   * (= location.timestamp) so the event lands in its historical hour-bucket and
   * derives a stable TimeUUID; the live tail omits it (fresh ingest-time id).
   */
  writeAisPositionFixObserved(
    data: AisPositionFixObserved,
    opts?: { eventTime?: Date },
  ): Promise<string>;
  /**
   * Batch emit (one HTTP request per N fixes; each still a distinct event).
   * Webhook latency is per-request, so batching is the throughput lever — used by
   * BOTH the backfill and the live tail. `opts.useEventTime` (default true) makes
   * the platform derive each event's historical TimeUUID + hour-bucket from its
   * own `eventTime` field (`eventTimeKey`). The tail passes `false` so live fixes
   * get fresh ingest-time TimeUUIDs/buckets instead (no eventTime override).
   */
  writeAisPositionFixBatch(
    events: AisPositionFixObserved[],
    opts?: { useEventTime?: boolean },
  ): Promise<string[]>;
}

export type PathwayRuntime = {
  writer: PathwayWriter;
  router: PathwayRouter;
  startPump(): Promise<void>;
  stopPump(): Promise<void>;
};

export function createPathwayRuntime(
  env: Env,
  repository: GenericEventRepository,
  chunkAssembler: JMeldingChunkAssembler,
  areasProjector: AreasProjector,
  sildelagetCatchProjector: SildelagetCatchProjector,
  aisProjector: AisPositionProjector,
  gillnetProjector: GillnetProjector,
  gebcoProjector: GebcoProjector,
  poiFragmentProjector: PoiFragmentProjector,
): PathwayRuntime {
  const runtimeEnv =
    env.NODE_ENV === "production"
      ? "production"
      : env.NODE_ENV === "test"
        ? "test"
        : "development";

  const pathways = new PathwaysBuilder({
    tenant: env.FLOWCORE_TENANT,
    dataCore: env.FLOWCORE_DATA_CORE,
    apiKey: env.FLOWCORE_API_KEY,
    baseUrl: env.FLOWCORE_API_URL,
    pathwayTimeoutMs: 30000,
    dataCoreDescription: "Fishfacts AI backend event data core",
    dataCoreAccessControl: "private",
    dataCoreDeleteProtection: true,
    pathwayName: "fishfacts-ai-backend",
    advertisedUrl: env.SERVICE_URL,
    resetSecret: env.PUMP_RESET_SECRET,
    resetPath: "/reset",
    runtimeEnv,
    pathwayMode: "virtual",
    pathwayLabels: {
      name: "fishfacts-ai-backend",
      description: "FishFacts AI backend — j-melding ingestion + API events",
      service: "fishfacts-ai-backend",
      env: env.NODE_ENV,
    },
    autoProvision: {
      dataCore: true,
      flowType: true,
      eventType: true,
      pathway: true,
    },
  } as ConstructorParameters<typeof PathwaysBuilder>[0]);

  pathways
    .register({
      flowType: GENERIC_FLOW_TYPE,
      eventType: GENERIC_EVENT_TYPE,
      schema: genericEventInputSchema,
      flowTypeDescription: "Generic Fishfacts AI backend events",
      description: "Generic event received by the Fishfacts AI backend",
    })
    .handle(GENERIC_PATHWAY, async (event) => {
      await repository.upsertFromEvent(event as never);
    });

  pathways
    .register({
      flowType: ANNOUNCEMENT_FLOW_TYPE,
      eventType: JMELDING_ANNOUNCEMENT_DISCOVERED_EVENT_TYPE,
      schema: jmeldingAnnouncementDiscoveredSchema,
      flowTypeDescription: "FishFacts announcement events",
      description: "A Fiskeridir J-melding announcement was discovered",
    })
    .handle(JMELDING_ANNOUNCEMENT_PATHWAY, async (event) => {
      const parsed = jmeldingAnnouncementDiscoveredSchema.parse(
        (event as { payload: unknown }).payload,
      );
      await chunkAssembler.handle(parsed);
    });

  pathways
    .register({
      flowType: AREA_FLOW_TYPE,
      eventType: AREA_CREATED_EVENT_TYPE,
      schema: areaCreatedSchema,
      flowTypeDescription: "FishFacts admin-managed global map areas",
      description: "An admin user created a global map area",
    })
    .handle(AREA_CREATED_PATHWAY, async (event) => {
      const envelope = event as { eventId: string; payload: unknown };
      const parsed = areaCreatedSchema.parse(envelope.payload);
      await areasProjector.handleCreated({ eventId: envelope.eventId }, parsed);
    });

  pathways
    .register({
      flowType: AREA_FLOW_TYPE,
      eventType: AREA_UPDATED_EVENT_TYPE,
      schema: areaUpdatedSchema,
      flowTypeDescription: "FishFacts admin-managed global map areas",
      description: "An admin user updated a global map area",
    })
    .handle(AREA_UPDATED_PATHWAY, async (event) => {
      const envelope = event as { eventId: string; payload: unknown };
      const parsed = areaUpdatedSchema.parse(envelope.payload);
      await areasProjector.handleUpdated({ eventId: envelope.eventId }, parsed);
    });

  pathways
    .register({
      flowType: AREA_FLOW_TYPE,
      eventType: AREA_DELETED_EVENT_TYPE,
      schema: areaDeletedSchema,
      flowTypeDescription: "FishFacts admin-managed global map areas",
      description: "An admin user deleted a global map area (soft delete)",
    })
    .handle(AREA_DELETED_PATHWAY, async (event) => {
      const envelope = event as { eventId: string; payload: unknown };
      const parsed = areaDeletedSchema.parse(envelope.payload);
      await areasProjector.handleDeleted({ eventId: envelope.eventId }, parsed);
    });

  pathways
    .register({
      flowType: POI_FLOW_TYPE,
      eventType: POI_CREATED_EVENT_TYPE,
      schema: poiCreatedSchema,
      flowTypeDescription:
        "FishFacts Point-of-Interest gazetteer (narrative boundary landmarks)",
      description:
        "An admin taught the POI gazetteer a named coordinate (upsert by key)",
    })
    .handle(POI_CREATED_PATHWAY, async (event) => {
      const envelope = event as { eventId: string; payload: unknown };
      const parsed = poiCreatedSchema.parse(envelope.payload);
      await poiFragmentProjector.project(parsed);
    });

  pathways
    .register({
      flowType: SILDELAGET_CATCHJOURNAL_FLOW_TYPE,
      eventType: SILDELAGET_CATCH_ENTRY_OBSERVED_EVENT_TYPE,
      schema: sildelagetCatchEntryObservedSchema,
      flowTypeDescription: "FishFacts Sildelaget catch journal events",
      description: "A Sildelaget innmeldingsjournal entry was observed",
    })
    .handle(SILDELAGET_CATCH_ENTRY_OBSERVED_PATHWAY, async (event) => {
      await sildelagetCatchProjector.handleObserved(
        event as { eventId: string; payload: unknown },
      );
    });

  pathways
    .register({
      flowType: AIS_FLOW_TYPE,
      eventType: AIS_POSITION_FIX_OBSERVED_EVENT_TYPE,
      schema: aisPositionFixObservedSchema,
      flowTypeDescription: "FishFacts AIS vessel position events",
      description: "A vessel AIS position fix was observed",
      // Projection retry rides the data-pump (reOpen / maxRedeliveryCount /
      // per-flow-type restart); these cover transient webhook send failures.
      maxRetries: 4,
      retryStatusCodes: [500, 502, 503, 504],
    } as never)
    .handle(AIS_POSITION_FIX_OBSERVED_PATHWAY, async (event) => {
      await aisProjector.handleObserved(
        event as { eventId: string; payload: unknown },
      );
    });

  pathways
    .register({
      flowType: GILLNET_FLOW_TYPE,
      eventType: GILLNET_VESSEL_OBSERVED_EVENT_TYPE,
      schema: gillnetVesselObservedSchema,
      flowTypeDescription: "FishFacts Faroese gillnet position events",
      description: "A Faroese gillnet vessel's set nets were observed",
    } as never)
    .handle(GILLNET_VESSEL_OBSERVED_PATHWAY, async (event) => {
      await gillnetProjector.handleObserved(
        event as { eventId: string; payload: unknown },
      );
    });

  pathways
    .register({
      flowType: GEBCO_FLOW_TYPE,
      eventType: GEBCO_FEATURE_OBSERVED_EVENT_TYPE,
      schema: gebcoFeatureObservedSchema,
      flowTypeDescription: "FishFacts GEBCO undersea feature name events",
      description: "An IHO-IOC GEBCO undersea feature was observed",
    } as never)
    .handle(GEBCO_FEATURE_OBSERVED_PATHWAY, async (event) => {
      await gebcoProjector.handleObserved(
        event as { eventId: string; payload: unknown },
      );
    });

  const router = new PathwayRouter(pathways, env.FLOWCORE_TRANSFORMER_SECRET);

  return {
    writer: {
      async writeGeneric(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof GENERIC_PATHWAY,
            input: {
              data: z.infer<typeof genericEventInputSchema>;
              metadata: Record<string, unknown>;
            },
          ) => Promise<string | string[]>
        )(GENERIC_PATHWAY, {
          data,
          metadata: { source: "fishfacts-ai-backend-api" },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeJMeldingAnnouncement(data) {
        const chunks = chunkAnnouncement(data);
        const eventIds: string[] = [];
        for (const chunk of chunks) {
          const eventId = await (
            pathways.write as never as (
              path: typeof JMELDING_ANNOUNCEMENT_PATHWAY,
              input: {
                data: JMeldingAnnouncementDiscovered;
                metadata: Record<string, unknown>;
                options?: { fireAndForget?: boolean };
              },
            ) => Promise<string | string[]>
          )(JMELDING_ANNOUNCEMENT_PATHWAY, {
            data: chunk,
            metadata: { source: "fiskeridir-jmeldinger-job" },
            options: { fireAndForget: true },
          });
          eventIds.push(Array.isArray(eventId) ? eventId[0] : eventId);
        }
        return eventIds[0];
      },
      async writeSildelagetCatchEntryObserved(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof SILDELAGET_CATCH_ENTRY_OBSERVED_PATHWAY,
            input: {
              data: SildelagetCatchEntryObserved;
              metadata: Record<string, unknown>;
              options?: { fireAndForget?: boolean };
            },
          ) => Promise<string | string[]>
        )(SILDELAGET_CATCH_ENTRY_OBSERVED_PATHWAY, {
          data,
          metadata: {
            source: "sildelaget-catchjournal-job",
            innmeldingId: data.innmeldingId,
            entryHash: data.entryHash,
          },
          options: { fireAndForget: true },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeGillnetVesselObserved(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof GILLNET_VESSEL_OBSERVED_PATHWAY,
            input: {
              data: GillnetVesselObserved;
              metadata: Record<string, unknown>;
              options?: { fireAndForget?: boolean };
            },
          ) => Promise<string | string[]>
        )(GILLNET_VESSEL_OBSERVED_PATHWAY, {
          data,
          metadata: {
            source: "gillnet-positions-job",
            callSign: data.callSign,
            snapshotDate: data.snapshotDate,
          },
          options: { fireAndForget: true },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeGebcoFeatureObserved(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof GEBCO_FEATURE_OBSERVED_PATHWAY,
            input: {
              data: GebcoFeatureObserved;
              metadata: Record<string, unknown>;
              options?: { fireAndForget?: boolean };
            },
          ) => Promise<string | string[]>
        )(GEBCO_FEATURE_OBSERVED_PATHWAY, {
          data,
          metadata: {
            source: "gebco-ingest-job",
            featureId: data.featureId,
          },
          options: { fireAndForget: true },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeAreaCreated(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof AREA_CREATED_PATHWAY,
            input: {
              data: AreaCreated;
              metadata: Record<string, unknown>;
            },
          ) => Promise<string | string[]>
        )(AREA_CREATED_PATHWAY, {
          data,
          metadata: {
            source: "fishfacts-ai-backend-api",
            areaId: data.areaId,
            createdBy: data.createdBy,
          },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writePoiCreated(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof POI_CREATED_PATHWAY,
            input: {
              data: PoiCreated;
              metadata: Record<string, unknown>;
            },
          ) => Promise<string | string[]>
        )(POI_CREATED_PATHWAY, {
          data,
          metadata: {
            source: "fishfacts-ai-backend-api",
            poiKey: data.key,
            verifiedBy: data.verifiedBy,
          },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeAreaUpdated(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof AREA_UPDATED_PATHWAY,
            input: {
              data: AreaUpdated;
              metadata: Record<string, unknown>;
            },
          ) => Promise<string | string[]>
        )(AREA_UPDATED_PATHWAY, {
          data,
          metadata: {
            source: "fishfacts-ai-backend-api",
            areaId: data.areaId,
            updatedBy: data.updatedBy,
          },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeAreaDeleted(data) {
        const eventId = await (
          pathways.write as never as (
            path: typeof AREA_DELETED_PATHWAY,
            input: {
              data: AreaDeleted;
              metadata: Record<string, unknown>;
            },
          ) => Promise<string | string[]>
        )(AREA_DELETED_PATHWAY, {
          data,
          metadata: {
            source: "fishfacts-ai-backend-api",
            areaId: data.areaId,
            deletedBy: data.deletedBy,
          },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeAisPositionFixObserved(data, opts) {
        const eventId = await (
          pathways.write as never as (
            path: typeof AIS_POSITION_FIX_OBSERVED_PATHWAY,
            input: {
              data: AisPositionFixObserved;
              metadata: Record<string, unknown>;
              options?: { fireAndForget?: boolean; eventTime?: Date };
            },
          ) => Promise<string | string[]>
        )(AIS_POSITION_FIX_OBSERVED_PATHWAY, {
          data,
          // Flowcore metadata values must be strings — numeric values make the
          // webhook return { success: false }.
          metadata: {
            source: data.source,
            vesselId: String(data.vesselId),
            sourceId: String(data.sourceId),
          },
          options: {
            fireAndForget: true,
            ...(opts?.eventTime ? { eventTime: opts.eventTime } : {}),
          },
        });
        return Array.isArray(eventId) ? eventId[0] : eventId;
      },
      async writeAisPositionFixBatch(events, opts) {
        const useEventTime = opts?.useEventTime ?? true;
        const ids = await (
          pathways.write as never as (
            path: typeof AIS_POSITION_FIX_OBSERVED_PATHWAY,
            input: {
              batch: true;
              data: AisPositionFixObserved[];
              metadata: Record<string, unknown>;
              options?: {
                fireAndForget?: boolean;
                eventTimeKey?: string;
              };
            },
          ) => Promise<string | string[]>
        )(AIS_POSITION_FIX_OBSERVED_PATHWAY, {
          batch: true,
          data: events,
          metadata: { source: "mysql-replica" },
          options: {
            fireAndForget: true,
            // Backfill: per-event historical bucket + TimeUUID from each payload's
            // eventTime. Tail: omit, so events get fresh ingest-time TimeUUIDs.
            ...(useEventTime ? { eventTimeKey: "eventTime" } : {}),
          },
        });
        return Array.isArray(ids) ? ids : [ids];
      },
    },
    router,
    async startPump() {
      if (env.DISABLE_EVENT_STREAMING) return;
      if (runtimeEnv === "production") {
        const coordinator = await createPostgresPathwayCoordinator({
          connectionString: env.DATABASE_URL,
        });
        await pathways.startCluster({
          coordinator,
          advertisedAddress: env.POD_IP,
          port: env.CLUSTER_PORT,
          transport: createNodeTransport(),
        });
      }
      const stateManagerFactory = await createPostgresPumpStateManagerFactory({
        connectionString: env.DATABASE_URL,
      });
      await pathways.startPump({
        stateManagerFactory,
        notifier: { type: "websocket" },
        // The pump reserves `concurrency` events per cycle and pays fixed
        // per-cycle overhead (ack + setState). AIS is a firehose, so reserve a
        // large batch to amortize; bufferSize must be >= the largest concurrency
        // so reserve() can fill. Out-of-order projection is safe (CH orders at
        // merge/query time). Low-volume flow types stay at default 1.
        bufferSize: env.AIS_PUMP_BUFFER_SIZE,
        concurrency: {
          // Each flow type runs its own pump. Low-volume flows
          // (announcement/closures, areas, generic, sildelaget) each do ~2
          // sequential usable.dev round-trips per event, so at concurrency 1 a
          // backlog drains painfully slowly — project several in parallel
          // (closure/J-melding keys are unique per event, so out-of-order
          // projection is safe; geo + fragment upserts are idempotent). AIS
          // keeps its own high concurrency via the per-flow-type override.
          default: 8,
          byFlowType: {
            [AIS_FLOW_TYPE]: env.AIS_PUMP_CONCURRENCY,
            // GEBCO is a one-shot ~5,189-event bulk reference load. On the
            // default 8 it drains slowly because the box is dominated by the
            // AIS firehose (shared CPU / pg pool / API / notifier), inflating
            // each pump cycle. A higher per-flow-type concurrency reserves more
            // per cycle so a refresh drains in minutes, not hours. Upserts are
            // idempotent (PK feature_id), so out-of-order projection is safe.
            [GEBCO_FLOW_TYPE]: 48,
          },
        },
        autoProvision: {
          dataCore: true,
          flowType: true,
          eventType: true,
          pathway: true,
        },
      } as never);
    },
    async stopPump() {
      await pathways.stopPump();
      if (runtimeEnv === "production") {
        await pathways.stopCluster();
      }
    },
  };
}
