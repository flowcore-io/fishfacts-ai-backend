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
  GENERIC_EVENT_TYPE,
  GENERIC_FLOW_TYPE,
  GENERIC_PATHWAY,
  JMELDING_ANNOUNCEMENT_DISCOVERED_EVENT_TYPE,
  JMELDING_ANNOUNCEMENT_PATHWAY,
  type JMeldingAnnouncementDiscovered,
  SILDELAGET_CATCHJOURNAL_FLOW_TYPE,
  SILDELAGET_CATCH_ENTRY_OBSERVED_EVENT_TYPE,
  SILDELAGET_CATCH_ENTRY_OBSERVED_PATHWAY,
  type SildelagetCatchEntryObserved,
  aisPositionFixObservedSchema,
  areaCreatedSchema,
  areaDeletedSchema,
  areaUpdatedSchema,
  genericEventInputSchema,
  jmeldingAnnouncementDiscoveredSchema,
  sildelagetCatchEntryObservedSchema,
} from "./events/contracts";
import { chunkAnnouncement } from "./events/jmelding-chunking";
import type { GenericEventRepository } from "./events/repository";
import type { JMeldingChunkAssembler } from "./jobs/jmelding-chunk-assembler";
import type { SildelagetCatchProjector } from "./sildelaget/projector";

export interface PathwayWriter {
  writeGeneric(data: z.infer<typeof genericEventInputSchema>): Promise<string>;
  writeJMeldingAnnouncement(
    data: JMeldingAnnouncementDiscovered,
  ): Promise<string>;
  writeSildelagetCatchEntryObserved(
    data: SildelagetCatchEntryObserved,
  ): Promise<string>;
  writeAreaCreated(data: AreaCreated): Promise<string>;
  writeAreaUpdated(data: AreaUpdated): Promise<string>;
  writeAreaDeleted(data: AreaDeleted): Promise<string>;
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
   * Used by the backfill — webhook latency is per-request, so batching is the
   * throughput lever. `eventTimeKey: "eventTime"` makes the platform derive each
   * event's historical TimeUUID + hour-bucket from its own `eventTime` field.
   */
  writeAisPositionFixBatch(events: AisPositionFixObserved[]): Promise<string[]>;
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
      async writeAisPositionFixBatch(events) {
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
          // Per-event historical time-bucket + TimeUUID from each payload's eventTime.
          options: { fireAndForget: true, eventTimeKey: "eventTime" },
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
          default: 1,
          byFlowType: { [AIS_FLOW_TYPE]: env.AIS_PUMP_CONCURRENCY },
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
