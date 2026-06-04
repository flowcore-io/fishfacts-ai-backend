import type { Env } from "@/env";
import type { PathwayWriter } from "@/pathways";
import type { SildelagetCatchRepository } from "@/sildelaget/repository";
import type { UsableApiClient } from "@/usable/client";
import { z } from "zod";
import { createFiskeridirJMeldingerJob } from "./fiskeridir-jmeldinger";
import { createSildelagetCatchJournalJob } from "./sildelaget-catchjournal";
import type { JobDefinition } from "./types";

export function createJobDefinitions(
  env: Env,
  writer: PathwayWriter,
  usable: UsableApiClient,
  sildelagetCatchRepository: SildelagetCatchRepository,
): JobDefinition[] {
  return [
    {
      id: "fiskeridir-jmeldinger",
      name: "Fiskeridir J-meldinger collector",
      schedule: "0 * * * *",
      inputSchema: z.object({
        maxItems: z.coerce.number().int().min(1).default(10000),
        maxPages: z.coerce.number().int().min(1).default(500),
        includeArchived: z.coerce.boolean().default(true),
        refreshExisting: z.coerce.boolean().default(false),
      }),
      execute: createFiskeridirJMeldingerJob(env, writer, {
        loadKnownKeys: () =>
          usable.listFragmentKeys({
            workspaceId: env.USABLE_WORKSPACE_ID,
            fragmentTypeId: env.JMELDING_FRAGMENT_TYPE_ID,
            status: "active",
          }),
      }),
    },
    {
      id: "sildelaget-catchjournal",
      name: "Sildelaget catch journal collector",
      schedule: "0 * * * *",
      inputSchema: z.object({
        selectedTime: z.coerce.number().int().min(1).default(168),
        selectedSpecies: z.string().default(""),
        selectedCatchType: z.string().default(""),
        isNor: z.coerce.boolean().default(true),
        backfill: z.coerce.boolean().default(false),
      }),
      execute: createSildelagetCatchJournalJob(
        env,
        writer,
        sildelagetCatchRepository,
      ),
    },
  ];
}
