import { regulationApplicabilitySchema } from "@/regulations/applicability";
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

export const REGULATION_ADMIN_ACTION_RECORDED_EVENT_TYPE =
  "regulation.case.admin-action.recorded.0" as const;
export const REGULATION_ADMIN_ACTION_RECORDED_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${REGULATION_ADMIN_ACTION_RECORDED_EVENT_TYPE}` as const;

/**
 * The §12 inbox actions, one discriminated union under a single event type:
 * the actions share a shape (who did what to which case, when) and the
 * per-action payload is tiny, so one type keeps the flow-type provisioning
 * surface minimal — each additional auto-provisioned name is another chance
 * for the duplicate-flow-type failure documented on REGULATION_FLOW_TYPE.
 *
 * Approval and revision events (stage ② B3) are deliberately NOT actions:
 * they target a revision id, not a case, and carry their own semantics.
 */
export const regulationAdminActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mark_read"), read: z.boolean() }),
  z.object({
    kind: z.literal("assign"),
    /** null unassigns. */
    assignee: z.string().min(1).max(200).nullable(),
  }),
  z.object({
    kind: z.literal("set_urgency"),
    /** null clears back to routine. */
    urgency: z.enum(["critical", "high", "medium", "low"]).nullable(),
  }),
  z.object({
    kind: z.literal("snooze"),
    /** null wakes the case immediately. */
    until: z.string().datetime().nullable(),
  }),
  z.object({
    kind: z.literal("request_information"),
    /** What is missing, in the admin's words — carried on the action (and
     * its log row) so the ask survives; the answer arrives as a revision
     * (B3), never as a mutation here. */
    note: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("reject"),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("mark_duplicate"),
    duplicateOfCaseId: z.string().uuid(),
  }),
]);
export type RegulationAdminAction = z.infer<typeof regulationAdminActionSchema>;

/**
 * An administrator acted on a queue case. The route stamps `actor` from the
 * authenticated admin and `recordedAt` from the server clock — the same
 * cannot-be-forged posture as the POI write path.
 */
export const regulationAdminActionRecordedSchema = z.object({
  actionId: z.string().uuid(),
  caseId: z.string().uuid(),
  /** The source's own identity for the case — redundant with caseId but kept
   * on every event so the stream stays greppable without the projection. */
  caseKey: z.string().min(1),
  action: regulationAdminActionSchema,
  /** `admin:<username>`. */
  actor: z.string().min(1),
  recordedAt: z.string().datetime(),
});
export type RegulationAdminActionRecorded = z.infer<
  typeof regulationAdminActionRecordedSchema
>;

export const REGULATION_REVISION_PROPOSED_EVENT_TYPE =
  "regulation.case.revision.proposed.0" as const;
export const REGULATION_REVISION_PROPOSED_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${REGULATION_REVISION_PROPOSED_EVENT_TYPE}` as const;
export const REGULATION_REVISION_POINTER_MOVED_EVENT_TYPE =
  "regulation.case.revision.pointer-moved.0" as const;
export const REGULATION_REVISION_POINTER_MOVED_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${REGULATION_REVISION_POINTER_MOVED_EVENT_TYPE}` as const;
export const REGULATION_VALIDATION_RECORDED_EVENT_TYPE =
  "regulation.case.validation.recorded.0" as const;
export const REGULATION_VALIDATION_RECORDED_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${REGULATION_VALIDATION_RECORDED_EVENT_TYPE}` as const;
export const REGULATION_APPROVAL_RECORDED_EVENT_TYPE =
  "regulation.case.approval.recorded.0" as const;
export const REGULATION_APPROVAL_RECORDED_PATHWAY =
  `${REGULATION_FLOW_TYPE}/${REGULATION_APPROVAL_RECORDED_EVENT_TYPE}` as const;

/**
 * The editable interpretation of a case — every field an admin (or the agent
 * acting for one) may redraft. A revision event carries the COMPLETE
 * resulting snapshot, not a delta: undo is then a pure pointer move with no
 * chain replay, and the projection stays self-contained under replay.
 * Dates are ISO instants; null clears.
 */
export const regulationRevisionFieldsSchema = z.object({
  title: z.string().min(1).max(500),
  authority: z.string().max(200).nullable(),
  regulationNumber: z.string().max(100).nullable(),
  category: z.string().max(200).nullable(),
  summary: z.string().max(2000).nullable(),
  effectiveFrom: z.string().datetime().nullable(),
  effectiveTo: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  seasonalRecurrence: z.string().max(500).nullable(),
  interpretationNotes: z.string().max(4000).nullable(),
  applicability: regulationApplicabilitySchema.nullable(),
});
export type RegulationRevisionFields = z.infer<
  typeof regulationRevisionFieldsSchema
>;

/** One area of a revision draft — the same shape the case projector writes,
 * minus the server-derived columns (ids, PostGIS geom). */
export const regulationRevisionGeometrySchema = z.object({
  name: z.string().max(300).nullable().default(null),
  section: z.string().max(200).nullable().default(null),
  kind: z.enum(["closure", "exemption", "other"]).default("closure"),
  season: z.string().max(200).nullable().default(null),
  verticesQuoted: z.array(z.string().max(200)).nullable().default(null),
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      }),
    )
    .min(1),
  geometrySource: z.enum(["enumerated", "preparsed", "described"]),
  coordinateSystem: z.string().max(50).default("WGS84"),
  precision: z.string().max(100).nullable().default(null),
});
export type RegulationRevisionGeometry = z.infer<
  typeof regulationRevisionGeometrySchema
>;

export const REGULATION_REVISION_CHANGE_FIELDS = [
  ...regulationRevisionFieldsSchema.keyof().options,
  "geometries",
] as const;

/** Which field moved and WHY — §12's per-change justification. The values
 * live in the snapshot; the justification is the part only a human (or the
 * agent they instructed) can supply. */
export const regulationRevisionChangeSchema = z.object({
  field: z.enum(
    REGULATION_REVISION_CHANGE_FIELDS as unknown as [string, ...string[]],
  ),
  justification: z.string().min(1).max(2000),
});
export type RegulationRevisionChange = z.infer<
  typeof regulationRevisionChangeSchema
>;

/**
 * A redraft of a case's interpretation, addressable forever: approvals and
 * validations name revision ids, so the id rides in the event and survives
 * projection rebuilds. `baseRevisionId` is the revision the edit was made
 * against — the projector refuses to land a draft whose base is no longer
 * current (the edit-after-source-change race).
 */
export const regulationRevisionProposedSchema = z.object({
  revisionId: z.string().uuid(),
  caseId: z.string().uuid(),
  caseKey: z.string().min(1),
  baseRevisionId: z.string().uuid(),
  changes: z.array(regulationRevisionChangeSchema).min(1),
  fields: regulationRevisionFieldsSchema,
  /** The complete resulting area set (copied from the base when untouched);
   * empty = the case has no drawable areas. */
  geometries: z.array(regulationRevisionGeometrySchema),
  /** `admin:<username>` — stamped by the route from the auth token. */
  actor: z.string().min(1),
  recordedAt: z.string().datetime(),
});
export type RegulationRevisionProposed = z.infer<
  typeof regulationRevisionProposedSchema
>;

/** Undo/redo: the case's current-revision pointer moved to an existing
 * revision. A system affordance, deterministic, never agent behaviour. */
export const regulationRevisionPointerMovedSchema = z.object({
  pointerMoveId: z.string().uuid(),
  caseId: z.string().uuid(),
  caseKey: z.string().min(1),
  toRevisionId: z.string().uuid(),
  actor: z.string().min(1),
  recordedAt: z.string().datetime(),
});
export type RegulationRevisionPointerMoved = z.infer<
  typeof regulationRevisionPointerMovedSchema
>;

/**
 * One validation decision, always against a named revision id. Legal and
 * geometry validation are SEPARATE decisions (§12); geometry validation is
 * per-area, so `geometryId` is required exactly when the scope is geometry.
 */
export const regulationValidationRecordedSchema = z
  .object({
    validationId: z.string().uuid(),
    caseId: z.string().uuid(),
    caseKey: z.string().min(1),
    revisionId: z.string().uuid(),
    scope: z.enum(["legal", "geometry"]),
    geometryId: z.string().uuid().nullable().default(null),
    validated: z.boolean(),
    note: z.string().max(2000).nullable().default(null),
    actor: z.string().min(1),
    recordedAt: z.string().datetime(),
  })
  .refine(
    (value) =>
      value.scope === "geometry"
        ? value.geometryId !== null
        : value.geometryId === null,
    {
      message: "geometryId is required exactly when scope is geometry",
      path: ["geometryId"],
    },
  );
export type RegulationValidationRecorded = z.infer<
  typeof regulationValidationRecordedSchema
>;

/**
 * An approval of a SPECIFIC revision — what closes the edit-after-review
 * race. The route refuses a stale revision with the diff; the projector
 * re-checks under stream order and records a refused approval rather than
 * applying it, so the audit trail keeps even the race losers.
 * `metadataOnly` honours §12's publish-metadata-only path: legal validation
 * suffices when no geometry can be verified.
 */
export const regulationApprovalRecordedSchema = z.object({
  approvalId: z.string().uuid(),
  caseId: z.string().uuid(),
  caseKey: z.string().min(1),
  revisionId: z.string().uuid(),
  metadataOnly: z.boolean().default(false),
  note: z.string().max(2000).nullable().default(null),
  actor: z.string().min(1),
  recordedAt: z.string().datetime(),
});
export type RegulationApprovalRecorded = z.infer<
  typeof regulationApprovalRecordedSchema
>;
