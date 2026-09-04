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
  /**
   * One plain-language sentence about what the regulation actually does.
   *
   * Distinct from `bodyMarkdown`, which is the SOURCE text — this is a reading
   * of it. It needs its own field because `jmelding_geo` keeps no body at all,
   * so a summary smuggled through `bodyMarkdown` is discarded at projection and
   * never reaches the popup. Optional: the Norwegian and Icelandic collectors
   * have no such line to give.
   */
  summary: z.string().optional(),
  bodyMarkdown: z.string().default(""),
  contentHash: z.string().optional(),
  // Points at a fragment that ALREADY exists and that we do not own — the
  // Lógasavn mirror of logir.fo. When set, the announcement projector does not
  // write its own fragment copy: the statute is the record, this is a derived
  // index over it, and a second copy would be a second thing to keep in sync.
  //
  // NOTHING EMITS THIS TODAY — the Lógasavn closure ingest that did was removed
  // in the teardown. Kept, not deleted: it is read in two places
  // (`jmelding-chunk-assembler`, and the Vørn ring-repair guard in
  // `geo-projector`) and both are wanted again if statute geometry returns. It
  // is dormant, not dead.
  sourceFragmentId: z.string().optional(),
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

export const POI_FLOW_TYPE = "fishfacts-poi.0" as const;
export const POI_CREATED_EVENT_TYPE = "poi.created.0" as const;
export const POI_CREATED_PATHWAY =
  `${POI_FLOW_TYPE}/${POI_CREATED_EVENT_TYPE}` as const;

/**
 * An admin taught the Point-of-Interest gazetteer a coordinate (upsert by
 * `key`). `verifiedBy`/`verifiedAt` are set by the route from the auth
 * context, never taken from the request body — durable POIs feed
 * `draw_regulation_boundary`, so attribution must be evidence, not a claim.
 */
/** Stable snake_case resolver key — shared with the route input schema and
 * the read model's fragment validation so the three can't drift. */
export const POI_KEY_RE = /^[a-z0-9_]+$/;

export const poiCreatedSchema = z.object({
  key: z.string().regex(POI_KEY_RE).min(1).max(80),
  title: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  aliases: z.array(z.string().min(1).max(120)).max(20).optional(),
  source: z.string().min(1).max(300),
  verifiedBy: z.string().min(1).max(120),
  verifiedAt: z.string().datetime(),
});
export type PoiCreated = z.infer<typeof poiCreatedSchema>;

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

export const GILLNET_FLOW_TYPE = "fishfacts-gillnet.0" as const;
export const GILLNET_VESSEL_OBSERVED_EVENT_TYPE =
  "gillnet.vessel.observed.0" as const;
export const GILLNET_VESSEL_OBSERVED_PATHWAY =
  `${GILLNET_FLOW_TYPE}/${GILLNET_VESSEL_OBSERVED_EVENT_TYPE}` as const;

const gillnetPointSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  area: z.string().nullable().default(null),
});
const gillnetLineSchema = z.object({
  idx: z.number().int(),
  from: gillnetPointSchema,
  to: gillnetPointSchema,
});

/**
 * One Faroese gillnet vessel's currently-set nets, from the Vørn GillnetPublic
 * daily snapshot. `snapshotDate` (YYYY-MM-DD) is the daily replace key — the
 * read model returns only the latest snapshot, so vessels that drop out fall
 * away automatically.
 */
export const gillnetVesselObservedSchema = z.object({
  callSign: z.string().min(1),
  vesselName: z.string().min(1),
  gearType: z.string().min(1),
  snapshotDate: z.string().min(1),
  lastUpdatedAt: z.string().optional(),
  nets: z.array(gillnetLineSchema),
  signature: z.string().min(1),
  checkedAt: z.string().datetime(),
});
export type GillnetVesselObserved = z.infer<typeof gillnetVesselObservedSchema>;

export const GEBCO_FLOW_TYPE = "fishfacts-gebco.0" as const;
export const GEBCO_FEATURE_OBSERVED_EVENT_TYPE =
  "gebco.feature.observed.0" as const;
export const GEBCO_FEATURE_OBSERVED_PATHWAY =
  `${GEBCO_FLOW_TYPE}/${GEBCO_FEATURE_OBSERVED_EVENT_TYPE}` as const;

export const gebcoGeometryTypeSchema = z.enum(["point", "line", "polygon"]);
export type GebcoGeometryType = z.infer<typeof gebcoGeometryTypeSchema>;

/**
 * One named undersea feature from the IHO-IOC GEBCO Gazetteer (banks, ridges,
 * basins, seamounts, …). `featureId` is the gazetteer's stable FEATURE_ID (kept
 * as text per the text-PK convention) so projection upserts by identity — the
 * dataset is append-mostly, so there is no snapshot full-replace. `bbox` is
 * `[minLon, minLat, maxLon, maxLat]`; `geomWkt` is WGS84 WKT (POINT / MULTIPOINT
 * / MULTILINESTRING / MULTIPOLYGON).
 */
export const gebcoFeatureObservedSchema = z.object({
  featureId: z.string().min(1),
  name: z.string().min(1),
  featureType: z.string().min(1),
  geometryType: gebcoGeometryTypeSchema,
  geomWkt: z.string().min(1),
  centroidLat: z.number(),
  centroidLon: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  signature: z.string().min(1),
  checkedAt: z.string().datetime(),
});
export type GebcoFeatureObserved = z.infer<typeof gebcoFeatureObservedSchema>;

/**
 * NOT `fishfacts-regulation.0`, which is burned.
 *
 * A pod crash straddled that flow type's auto-provisioning on 2026-09-03, and
 * the platform does not enforce name uniqueness within a data core — so the
 * name ended up on several distinct flow-type ids. Reads resolve an event-type
 * id back to (flowType, eventType) NAMES, and an ambiguous name resolves to
 * nothing: every read under it answers `404 Event type(s) not found` while
 * writes (which address by name) keep succeeding. Events written under it are
 * therefore unreadable, and the pump can never consume them.
 *
 * The version suffix stays `.0` because nothing about the contract changed —
 * only the name had to move somewhere unambiguous.
 */
export const REGULATION_FLOW_TYPE = "fishfacts-regulation-queue.0" as const;
export const REGULATION_VERDICT_RECORDED_EVENT_TYPE =
  "regulation.case.verdict.recorded.0" as const;
export const REGULATION_VERDICT_RECORDED_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${REGULATION_VERDICT_RECORDED_EVENT_TYPE}` as const;

/**
 * The verdict-issue taxonomy, sized against the corpus rather than in the
 * abstract (dry run of 2026-09-03 over the eight first-pass statutes,
 * approved by Johann the same day):
 *
 * - `underdetermined_boundary` — the dominant real class: a boundary described
 *   rather than enumerated (bearing lines from named landmarks, distance bands
 *   off the baselines, longitude limits). Flagged, never computed.
 * - `unsupported_notation` — readable digits in a grammar the tokenizer does
 *   not speak (K 113/2014's decimal-degree NEAFC tables). NOT malformed — the
 *   two route to different fixes.
 * - `external_reference` — an area defined in a different regulation
 *   (K 45/2022 § 2 stk. 2's area R), which otherwise vanishes silently.
 * - `malformed_coordinate` — wrong digit count, impossible minutes: a
 *   transcription problem in the source itself.
 * - `unresolved_landmark` — a named place with no printed coordinates; the
 *   hook stage ② hangs the POI capture loop on. Zero hits on the Faroese
 *   first pass (their statutes print landmark coordinates), kept for the day
 *   a source does not.
 * - `ambiguous_wording` / `missing_expiry` — the lawyer's-reading classes.
 * - `ok` — an explicit clean bill for the field, so silence stays
 *   distinguishable from "not examined".
 */
export const regulationVerdictIssueKindSchema = z.enum([
  "underdetermined_boundary",
  "unsupported_notation",
  "external_reference",
  "malformed_coordinate",
  "unresolved_landmark",
  "ambiguous_wording",
  "missing_expiry",
  "ok",
]);
export type RegulationVerdictIssueKind = z.infer<
  typeof regulationVerdictIssueKindSchema
>;

export const regulationVerdictIssueSchema = z.object({
  /** What the issue is about — a §/field/area reference in the source's own
   * words ("§ 2, stk. 1, nr. 3", "Skjal 1, Talva 2", "expiry"). */
  field: z.string().min(1).max(200),
  kind: regulationVerdictIssueKindSchema,
  /** What the issue points AT, when it points at something: the cited
   * regulation for external_reference, the landmark name, the offending
   * coordinate as printed. */
  ref: z.string().max(500).nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type RegulationVerdictIssue = z.infer<
  typeof regulationVerdictIssueSchema
>;

/**
 * A structured verdict over one revision of a regulation case.
 *
 * `status: "failed"` is the fail-closed state: the model's answer did not
 * validate against the issue schema, and that FACT is recorded rather than
 * salvaged — a case whose verdict failed is a case a human looks at.
 */
export const regulationVerdictRecordedSchema = z.object({
  verdictId: z.string().uuid(),
  caseKey: z.string().min(1),
  revisionId: z.string().uuid(),
  contentHash: z.string().nullable().default(null),
  status: z.enum(["ok", "failed"]),
  issues: z.array(regulationVerdictIssueSchema).default([]),
  /** Why a failed verdict failed — schema violation, no JSON, transport. */
  error: z.string().max(2000).nullable().default(null),
  model: z.string().nullable().default(null),
  recordedAt: z.string().datetime(),
});
export type RegulationVerdictRecorded = z.infer<
  typeof regulationVerdictRecordedSchema
>;
