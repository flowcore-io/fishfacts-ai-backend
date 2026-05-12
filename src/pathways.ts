import {
  PathwayRouter,
  PathwaysBuilder,
  createNodeTransport,
  createPostgresPathwayCoordinator,
  createPostgresPumpStateManagerFactory,
} from "@flowcore/pathways";
import type { z } from "zod";
import type { Env } from "./env";
import {
  ANNOUNCEMENT_FLOW_TYPE,
  GENERIC_EVENT_TYPE,
  GENERIC_FLOW_TYPE,
  GENERIC_PATHWAY,
  JMELDING_ANNOUNCEMENT_DISCOVERED_EVENT_TYPE,
  JMELDING_ANNOUNCEMENT_PATHWAY,
  type JMeldingAnnouncementDiscovered,
  genericEventInputSchema,
  jmeldingAnnouncementDiscoveredSchema,
} from "./events/contracts";
import { chunkAnnouncement } from "./events/jmelding-chunking";
import type { GenericEventRepository } from "./events/repository";
import type { JMeldingChunkAssembler } from "./jobs/jmelding-chunk-assembler";

export interface PathwayWriter {
  writeGeneric(data: z.infer<typeof genericEventInputSchema>): Promise<string>;
  writeJMeldingAnnouncement(
    data: JMeldingAnnouncementDiscovered,
  ): Promise<string>;
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
      service: "fishfacts-ai-backend",
      env: env.NODE_ENV,
    },
    autoProvision: {
      dataCore: true,
      flowType: true,
      eventType: true,
      pathway: false,
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
        autoProvision: {
          dataCore: true,
          flowType: true,
          eventType: true,
          pathway: false,
        },
      });
    },
    async stopPump() {
      await pathways.stopPump();
      if (runtimeEnv === "production") {
        await pathways.stopCluster();
      }
    },
  };
}
