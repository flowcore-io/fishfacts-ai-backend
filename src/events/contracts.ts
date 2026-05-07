import { z } from "zod";

export const GENERIC_FLOW_TYPE = "fishfacts-generic.0" as const;
export const GENERIC_EVENT_TYPE = "generic.received.0" as const;
export const GENERIC_PATHWAY =
  `${GENERIC_FLOW_TYPE}/${GENERIC_EVENT_TYPE}` as const;

export const ANNOUNCEMENT_FLOW_TYPE = "fishfacts-announcement.0" as const;
export const JMELDING_ANNOUNCEMENT_DISCOVERED_EVENT_TYPE =
  "jmelding.announcement.discovered.0" as const;
export const JMELDING_ANNOUNCEMENT_PATHWAY =
  `${ANNOUNCEMENT_FLOW_TYPE}/${JMELDING_ANNOUNCEMENT_DISCOVERED_EVENT_TYPE}` as const;

export const genericEventInputSchema = z.object({
  id: z.string().uuid(),
  kind: z.string().min(1).max(100),
  payload: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
});

export type GenericEventInput = z.infer<typeof genericEventInputSchema>;

export const jmeldingStatusSchema = z.enum(["current", "archived", "unknown"]);

export const jmeldingAnnouncementDiscoveredSchema = z.object({
  signature: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  status: jmeldingStatusSchema,
  publishedAt: z.string().optional(),
  createdAt: z.string().optional(),
  jmNumber: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  category: z.string().optional(),
  bodyMarkdown: z.string().default(""),
  contentHash: z.string().optional(),
  checkedAt: z.string().datetime(),
  partNumber: z.number().int().min(1).optional(),
  totalParts: z.number().int().min(1).optional(),
});

export type JMeldingAnnouncementDiscovered = z.infer<
  typeof jmeldingAnnouncementDiscoveredSchema
>;

export type FlowcoreEventEnvelope<TPayload = unknown> = {
  eventId: string;
  timeBucket: string;
  tenant: string;
  dataCoreId: string;
  flowType: string;
  eventType: string;
  metadata: Record<string, unknown>;
  payload: TPayload;
  validTime: string;
};
