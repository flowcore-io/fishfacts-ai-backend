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
  // Jurisdiction (default NO = Fiskeridir). FO = Vørn, IS = Fiskistofa.
  region: z.enum(["NO", "FO", "IS"]).default("NO"),
  // Pre-parsed geometry. Norwegian announcements omit this (the geo-projector
  // parses coords from `bodyMarkdown`); FO/IS collectors supply it directly so
  // the same projector lands them in the shared geo store.
  areas: z
    .array(
      z.object({
        name: z.string().nullable().default(null),
        points: z.array(z.object({ lat: z.number(), lon: z.number() })),
      }),
    )
    .optional(),
});

export type JMeldingAnnouncementDiscovered = z.infer<
  typeof jmeldingAnnouncementDiscoveredSchema
>;

export const SILDELAGET_CATCHJOURNAL_FLOW_TYPE =
  "fishfacts-sildelaget-catchjournal.0" as const;
export const SILDELAGET_CATCH_ENTRY_OBSERVED_EVENT_TYPE =
  "sildelaget.catchjournal.entry.observed.0" as const;
export const SILDELAGET_CATCH_ENTRY_OBSERVED_PATHWAY =
  `${SILDELAGET_CATCHJOURNAL_FLOW_TYPE}/${SILDELAGET_CATCH_ENTRY_OBSERVED_EVENT_TYPE}` as const;

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

export const sildelagetRouteCoordinateSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const sildelagetCatchLineSchema = z.object({
  lineKey: z.string().regex(/^[a-f0-9]{64}$/),
  lineIndex: z.number().int().min(0),
  fishingStartDate: nullableString,
  fishingStartTime: nullableString,
  species: nullableString,
  tonnes: nullableNumber,
  weightKg: nullableNumber,
  average: nullableNumber,
  catchType: nullableString,
  salesType: nullableString,
  gear: nullableString,
  route: nullableString,
  routeKey: nullableString.default(null),
  routeFaoArea: nullableString.default(null),
  routeCenterLatitude: nullableNumber.default(null),
  routeCenterLongitude: nullableNumber.default(null),
  routeCoordinates: z
    .array(sildelagetRouteCoordinateSchema)
    .nullable()
    .default(null),
  use: nullableString,
  pct1: nullableNumber,
  pct2: nullableNumber,
  pct3: nullableNumber,
  pct4: nullableNumber,
  assortment: nullableString,
  offerEastSouth: nullableString,
  offerEastSouthDate: nullableString,
  offerEastSouthTime: nullableString,
  offerEastNorth: nullableString,
  offerEastNorthDate: nullableString,
  offerEastNorthTime: nullableString,
  offerWestSouth: nullableString,
  offerWestSouthDate: nullableString,
  offerWestSouthTime: nullableString,
  offerWestNorth: nullableString,
  offerWestNorthDate: nullableString,
  offerWestNorthTime: nullableString,
  leasedVessel: nullableString,
  economicZone: nullableString,
  municipality: nullableString,
  coFisher: nullableString,
  buyer: nullableString,
  receiver: nullableString,
  nationality: nullableString,
  rawRow: z.record(z.unknown()).default({}),
});

export const sildelagetCatchEntryObservedSchema = z.object({
  innmeldingId: z.string().min(1),
  reportedDate: nullableString,
  reportedTime: nullableString,
  vesselName: nullableString,
  registrationMark: nullableString,
  entryHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.string().url(),
  checkedAt: z.string().datetime(),
  rawEntry: z.record(z.unknown()).default({}),
  lines: z.array(sildelagetCatchLineSchema),
});

export type SildelagetCatchLine = z.infer<typeof sildelagetCatchLineSchema>;
export type SildelagetCatchEntryObserved = z.infer<
  typeof sildelagetCatchEntryObservedSchema
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

export const AREA_FLOW_TYPE = "fishfacts-areas.0" as const;
export const AREA_CREATED_EVENT_TYPE = "area.created.0" as const;
export const AREA_UPDATED_EVENT_TYPE = "area.updated.0" as const;
export const AREA_DELETED_EVENT_TYPE = "area.deleted.0" as const;
export const AREA_CREATED_PATHWAY =
  `${AREA_FLOW_TYPE}/${AREA_CREATED_EVENT_TYPE}` as const;
export const AREA_UPDATED_PATHWAY =
  `${AREA_FLOW_TYPE}/${AREA_UPDATED_EVENT_TYPE}` as const;
export const AREA_DELETED_PATHWAY =
  `${AREA_FLOW_TYPE}/${AREA_DELETED_EVENT_TYPE}` as const;

export const areaGeometryTypeSchema = z.enum(["polygon", "polyline"]);
export type AreaGeometryType = z.infer<typeof areaGeometryTypeSchema>;

const geoJsonPolygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

const geoJsonLineString = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(z.tuple([z.number(), z.number()])),
});

export const areaGeometrySchema = z.discriminatedUnion("type", [
  geoJsonPolygon,
  geoJsonLineString,
]);
export type AreaGeometry = z.infer<typeof areaGeometrySchema>;

export const areaCreatedSchema = z.object({
  areaId: z.string().uuid(),
  name: z.string().min(1).max(120),
  groupName: z.string().min(1).max(80),
  geometryType: areaGeometryTypeSchema,
  geometry: areaGeometrySchema,
  color: z.string().min(1).max(32).optional(),
  notes: z.string().max(2000).optional(),
  createdBy: z.string().min(1).max(120),
  createdAt: z.string().datetime(),
});
export type AreaCreated = z.infer<typeof areaCreatedSchema>;

export const areaUpdatedSchema = z.object({
  areaId: z.string().uuid(),
  patch: z
    .object({
      name: z.string().min(1).max(120).optional(),
      groupName: z.string().min(1).max(80).optional(),
      geometryType: areaGeometryTypeSchema.optional(),
      geometry: areaGeometrySchema.optional(),
      color: z.string().min(1).max(32).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, {
      message: "patch must include at least one field",
    }),
  updatedBy: z.string().min(1).max(120),
  updatedAt: z.string().datetime(),
});
export type AreaUpdated = z.infer<typeof areaUpdatedSchema>;

export const areaDeletedSchema = z.object({
  areaId: z.string().uuid(),
  deletedBy: z.string().min(1).max(120),
  deletedAt: z.string().datetime(),
});
export type AreaDeleted = z.infer<typeof areaDeletedSchema>;

export const AIS_FLOW_TYPE = "fishfacts-ais.0" as const;
export const AIS_POSITION_FIX_OBSERVED_EVENT_TYPE =
  "ais.position.fix.observed.0" as const;
export const AIS_POSITION_FIX_OBSERVED_PATHWAY =
  `${AIS_FLOW_TYPE}/${AIS_POSITION_FIX_OBSERVED_EVENT_TYPE}` as const;

/**
 * A single vessel AIS position fix. Source-agnostic (MySQL replica now, Kafka
 * later). `sourceId` (= location.id) is the idempotency anchor used as the
 * ClickHouse ReplacingMergeTree key.
 */
export const aisPositionFixObservedSchema = z.object({
  sourceId: z.number().int().nonnegative(),
  vesselId: z.number().int(),
  vesselSourceId: z.number().int().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  speed: z.number().nullable(),
  heading: z.number().nullable(),
  course: z.number().nullable(),
  status: z.string().nullable(),
  eventTime: z.string().datetime(),
  ingestTime: z.string().datetime(),
  observedAt: z.string().datetime(),
  source: z.string().default("mysql-replica"),
});
export type AisPositionFixObserved = z.infer<
  typeof aisPositionFixObservedSchema
>;
