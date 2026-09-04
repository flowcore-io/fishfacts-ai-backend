import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const geometryMultiPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(MultiPoint, 4326)";
  },
});

const geometryMultiLineString = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "geometry(MultiLineString, 4326)";
  },
});

/** Mixed-type geometry column (GEBCO features are points, lines, or polygons). */
const geometryGeneric = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(Geometry, 4326)";
  },
});

export const genericEvents = pgTable("generic_events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  sourceEventId: text("source_event_id").notNull(),
  validTime: timestamp("valid_time", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const jmeldingChunkQueue = pgTable(
  "jmelding_chunk_queue",
  {
    signature: text("signature").notNull(),
    partNumber: integer("part_number").notNull(),
    totalParts: integer("total_parts").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.signature, table.partNumber] }),
    createdAtIdx: index("jmelding_chunk_queue_created_at_idx").on(
      table.createdAt,
    ),
  }),
);

export const areas = pgTable(
  "areas",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    groupName: text("group_name"),
    geometryType: text("geometry_type").notNull(),
    geometry: jsonb("geometry").notNull(),
    color: text("color"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    sourceEventId: text("source_event_id"),
  },
  (table) => ({
    deletedAtIdx: index("admin_areas_deleted_at_idx").on(table.deletedAt),
    nameIdx: index("admin_areas_name_idx").on(table.name),
    groupNameIdx: index("admin_areas_group_name_idx").on(table.groupName),
  }),
);

export const jmeldingGeo = pgTable(
  "jmelding_geo",
  {
    jmNumber: text("jm_number").primaryKey(),
    fragmentKey: text("fragment_key").notNull(),
    fragmentId: text("fragment_id"),
    title: text("title").notNull(),
    status: text("status").notNull(),
    // Jurisdiction: NO (Fiskeridir J-meldinger), FO (Vørn), IS (Fiskistofa).
    // Lets the shared geo search return + filter regulations by region.
    region: text("region").notNull().default("NO"),
    // Closure/regulation type (e.g. "hrygningarsvæði (spawning closure)",
    // "bráðfeingis veiðibann"). Lets the assistant colour-code + describe by type.
    category: text("category"),
    url: text("url").notNull(),
    // One plain-language sentence about what the regulation actually does,
    // written by whoever read the source. The popup is the only place a skipper
    // finds out whether a shape is a closure, a permit regime or a seasonal
    // carve-out, and `title - category (status)` does not say. Nullable: the
    // Norwegian and Icelandic collectors have no such line to give.
    summary: text("summary"),
    signature: text("signature").notNull(),
    // The exact source text this geometry was derived from. A row pointing at a
    // MUTATING source fragment otherwise means "whatever it says now" rather
    // than "what we actually parsed".
    contentHash: text("content_hash"),
    // Validity window as published by the source. `status` records what the
    // source called the regulation when we scraped it; these let a read decide
    // whether it is in force NOW, so a stale row stops being reported as
    // current without waiting for a re-scrape.
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    hasGeo: boolean("has_geo").notNull().default(false),
    areas: jsonb("areas").notNull().default([]),
    geojson: jsonb("geojson"),
    geom: geometryMultiPoint("geom"),
    minLat: doublePrecision("min_lat"),
    maxLat: doublePrecision("max_lat"),
    minLon: doublePrecision("min_lon"),
    maxLon: doublePrecision("max_lon"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    geomGistIdx: index("jmelding_geo_geom_gist_idx").using("gist", table.geom),
    statusIdx: index("jmelding_geo_status_idx").on(table.status),
    validToIdx: index("jmelding_geo_valid_to_idx").on(table.validTo),
    regionIdx: index("jmelding_geo_region_idx").on(table.region),
    hasGeoIdx: index("jmelding_geo_has_geo_idx").on(table.hasGeo),
    fragmentKeyIdx: index("jmelding_geo_fragment_key_idx").on(
      table.fragmentKey,
    ),
  }),
);

// Faroese gillnet positions (Vørn GillnetPublic). One row per vessel (call
// sign), replaced daily — `snapshot_date` is the daily key; the read model
// returns only rows at the latest snapshot so dropped-out vessels fall away.
export const gillnetPositions = pgTable(
  "gillnet_positions",
  {
    callSign: text("call_sign").primaryKey(),
    vesselName: text("vessel_name").notNull(),
    gearType: text("gear_type").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
    nets: jsonb("nets").notNull().default([]),
    geom: geometryMultiLineString("geom"),
    minLat: doublePrecision("min_lat"),
    maxLat: doublePrecision("max_lat"),
    minLon: doublePrecision("min_lon"),
    maxLon: doublePrecision("max_lon"),
    sourceEventId: text("source_event_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    snapshotIdx: index("gillnet_positions_snapshot_idx").on(table.snapshotDate),
    geomGistIdx: index("gillnet_positions_geom_gist_idx").using(
      "gist",
      table.geom,
    ),
  }),
);

export const gebcoFeatures = pgTable(
  "gebco_features",
  {
    featureId: text("feature_id").primaryKey(),
    name: text("name").notNull(),
    featureType: text("feature_type").notNull(),
    geometryType: text("geometry_type").notNull(),
    geom: geometryGeneric("geom"),
    centroidLat: doublePrecision("centroid_lat"),
    centroidLon: doublePrecision("centroid_lon"),
    minLat: doublePrecision("min_lat"),
    maxLat: doublePrecision("max_lat"),
    minLon: doublePrecision("min_lon"),
    maxLon: doublePrecision("max_lon"),
    sourceEventId: text("source_event_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    geomGistIdx: index("gebco_features_geom_gist_idx").using(
      "gist",
      table.geom,
    ),
    nameIdx: index("gebco_features_name_idx").on(table.name),
  }),
);

export const sildelagetCatchEntries = pgTable(
  "sildelaget_catch_entries",
  {
    innmeldingId: text("innmelding_id").primaryKey(),
    reportedDate: text("reported_date"),
    reportedTime: text("reported_time"),
    vesselName: text("vessel_name"),
    registrationMark: text("registration_mark"),
    entryHash: text("entry_hash").notNull(),
    sourceUrl: text("source_url").notNull(),
    rawEntry: jsonb("raw_entry").notNull().default({}),
    sourceEventId: text("source_event_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    reportedDateIdx: index("sildelaget_catch_entries_reported_date_idx").on(
      table.reportedDate,
    ),
    vesselNameIdx: index("sildelaget_catch_entries_vessel_name_idx").on(
      table.vesselName,
    ),
    registrationMarkIdx: index(
      "sildelaget_catch_entries_registration_mark_idx",
    ).on(table.registrationMark),
  }),
);

export const sildelagetCatchLines = pgTable(
  "sildelaget_catch_lines",
  {
    lineKey: text("line_key").primaryKey(),
    innmeldingId: text("innmelding_id").notNull(),
    lineIndex: integer("line_index").notNull(),
    fishingStartDate: text("fishing_start_date"),
    fishingStartTime: text("fishing_start_time"),
    species: text("species"),
    tonnes: doublePrecision("tonnes"),
    weightKg: doublePrecision("weight_kg"),
    average: doublePrecision("average"),
    catchType: text("catch_type"),
    salesType: text("sales_type"),
    gear: text("gear"),
    route: text("route"),
    routeKey: text("route_key"),
    routeFaoArea: text("route_fao_area"),
    routeCenterLatitude: doublePrecision("route_center_latitude"),
    routeCenterLongitude: doublePrecision("route_center_longitude"),
    routeCoordinates: jsonb("route_coordinates"),
    use: text("use"),
    pct1: doublePrecision("pct1"),
    pct2: doublePrecision("pct2"),
    pct3: doublePrecision("pct3"),
    pct4: doublePrecision("pct4"),
    assortment: text("assortment"),
    offerEastSouth: text("offer_east_south"),
    offerEastSouthDate: text("offer_east_south_date"),
    offerEastSouthTime: text("offer_east_south_time"),
    offerEastNorth: text("offer_east_north"),
    offerEastNorthDate: text("offer_east_north_date"),
    offerEastNorthTime: text("offer_east_north_time"),
    offerWestSouth: text("offer_west_south"),
    offerWestSouthDate: text("offer_west_south_date"),
    offerWestSouthTime: text("offer_west_south_time"),
    offerWestNorth: text("offer_west_north"),
    offerWestNorthDate: text("offer_west_north_date"),
    offerWestNorthTime: text("offer_west_north_time"),
    leasedVessel: text("leased_vessel"),
    economicZone: text("economic_zone"),
    municipality: text("municipality"),
    coFisher: text("co_fisher"),
    buyer: text("buyer"),
    receiver: text("receiver"),
    nationality: text("nationality"),
    rawRow: jsonb("raw_row").notNull().default({}),
    sourceEventId: text("source_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    innmeldingIdIdx: index("sildelaget_catch_lines_innmelding_id_idx").on(
      table.innmeldingId,
    ),
    speciesIdx: index("sildelaget_catch_lines_species_idx").on(table.species),
    routeKeyIdx: index("sildelaget_catch_lines_route_key_idx").on(
      table.routeKey,
    ),
  }),
);

// Derived catch positions: one row per innmelding, holding every AIS fishing
// run the report's track yields (sildelaget/ais-anchor.ts). Computed once by
// the sildelaget-ais-anchors job and read straight off /api/catch, so no user
// session ever pays for the derivation.
//
// `runs` is jsonb rather than a child table: it is written and read whole, is
// never queried into, and sits next to route_coordinates on the catch lines,
// which is stored the same way. `params` is the threshold set the row was
// derived under — when the band moves (PRD OQ9), rows derived under the old
// numbers are recomputed rather than silently mixed with the new ones.
export const sildelagetCatchAisAnchors = pgTable(
  "sildelaget_catch_ais_anchors",
  {
    innmeldingId: text("innmelding_id").primaryKey(),
    status: text("status").notNull(), // ok | no-vessel | no-track | no-run
    vesselId: integer("vessel_id"),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    reportedLatitude: doublePrecision("reported_latitude"),
    reportedLongitude: doublePrecision("reported_longitude"),
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    fixCount: integer("fix_count").notNull().default(0),
    runs: jsonb("runs").notNull().default([]),
    params: jsonb("params").notNull().default({}),
    paramsHash: text("params_hash").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // No index on `status`: the candidate query's retry clause ORs across both
  // sides of a LEFT JOIN, so one cannot be used (EXPLAIN: Seq Scan, 66 ms at
  // 20k × 20k, hourly). An index nothing plans for is a claim, not a speedup.
  (table) => ({
    computedAtIdx: index("sildelaget_catch_ais_anchors_computed_at_idx").on(
      table.computedAt,
    ),
  }),
);

// AIS ingestion control + emission progress (authoritative; run telemetry lives
// in the Usable job-state fragment). Rows: "config" (control) and "tail" (cursor).
//
// "config" row carries the cutover boundary T0 (start_at): the live tail covers
// [T0, ∞) (forward-fill), the backfill covers [backfill_start_at, T0) order=desc.
// backfill_enabled is the durable pause/resume switch the supervisor honors.
export const aisIngestState = pgTable("ais_ingest_state", {
  id: text("id").primaryKey(), // "config" | "tail"
  startAt: timestamp("start_at", { withTimezone: true }), // config: cutover T0
  backfillStartAt: timestamp("backfill_start_at", { withTimezone: true }), // config: oldest bucket (minEventTime)
  backfillEnabled: boolean("backfill_enabled").notNull().default(false), // config: durable backfill on/off
  cursor: jsonb("cursor"), // tail: { stampCreated, lastId }
  emittedCount: bigint("emitted_count", { mode: "number" })
    .notNull()
    .default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// One row per hour-bucket — the unit of backfill resume + parallelism. Each
// bucket is filled by ONE linear ascending stream to completion (plan §11 #1).
//
// TWO independent lifecycles per bucket (decoupled producer/consumer):
//   status            — EMIT: MySQL → Flowcore (pending|in_progress|complete)
//   projectionStatus  — PROJECT: Flowcore → ClickHouse (pending|in_progress|complete)
// The emit (backfill) job drives `status`; the CH-refill job claims buckets where
// status='complete' AND projection_status='pending' and drives `projectionStatus`.
export const aisBackfillBuckets = pgTable(
  "ais_backfill_buckets",
  {
    bucketHour: timestamp("bucket_hour", { withTimezone: true }).primaryKey(),
    status: text("status").notNull().default("pending"), // emit: pending|in_progress|complete
    projectionStatus: text("projection_status").notNull().default("pending"), // project: pending|in_progress|complete
    lastTs: timestamp("last_ts", { withTimezone: true }),
    lastId: bigint("last_id", { mode: "number" }),
    sourceCount: bigint("source_count", { mode: "number" }),
    emittedCount: bigint("emitted_count", { mode: "number" })
      .notNull()
      .default(0),
    projectedCount: bigint("projected_count", { mode: "number" })
      .notNull()
      .default(0),
    // Flowcore pagination cursor of the last page projected to ClickHouse, so the
    // CH-refill resumes a bucket MID-pagination across retries/restarts instead of
    // re-fetching from page 1 — a bucket can hold millions of events.
    projectedCursor: text("projected_cursor"),
    projectedAt: timestamp("projected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    statusIdx: index("ais_backfill_buckets_status_idx").on(table.status),
    projectionStatusIdx: index("ais_backfill_buckets_projection_status_idx").on(
      table.projectionStatus,
    ),
  }),
);

// Job-system state — moved off Usable memory fragments (which re-chunk + re-embed
// the whole doc on every PATCH, hammering Usable) into Postgres. One row per job
// in `job_state` (resume cursor + telemetry), plus a bounded `job_runs` history.
// The runner's JobStateStore reads/writes these; nothing else consumes them.
export const jobState = pgTable("job_state", {
  jobId: text("job_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  lastRunStatus: text("last_run_status").notNull().default("idle"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastDurationMs: bigint("last_duration_ms", { mode: "number" }),
  listingFingerprint: text("listing_fingerprint"),
  // Per-job resume cursor (jmelding/gillnet/vorn/fiskistofa). AIS jobs leave this
  // null — their cursor lives in ais_ingest_state / ais_backfill_buckets.
  cursor: jsonb("cursor"),
  progress: jsonb("progress"),
  latestItems: jsonb("latest_items").notNull().default([]),
  // Cumulative counters (job_runs is bounded, so it can't be the counter source).
  metrics: jsonb("metrics")
    .notNull()
    .default({ runs: 0, successes: 0, failures: 0, newDataEvents: 0 }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const jobRuns = pgTable(
  "job_runs",
  {
    runId: text("run_id").primaryKey(),
    jobId: text("job_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    args: jsonb("args"),
    error: text("error"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    changed: boolean("changed"),
  },
  (table) => ({
    jobStartedIdx: index("job_runs_job_id_started_at_idx").on(
      table.jobId,
      table.startedAt,
    ),
  }),
);

// EUR-based year-end FX rates cached from Frankfurter (ECB). Base is always EUR
// (EUR row = 1). Convert X→Y via rate(EUR→Y) / rate(EUR→X). One row per
// (year, quote); used to normalise annual-report figures to a display currency.
export const fxRate = pgTable(
  "fx_rate",
  {
    year: integer("year").notNull(),
    quote: text("quote").notNull(), // ISO 4217, e.g. "DKK"
    rate: doublePrecision("rate").notNull(), // EUR → quote
    asOf: text("as_of"), // the rate date used (YYYY-MM-DD)
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.year, table.quote] }),
  }),
);

// ---------------------------------------------------------------------------
// Regulations approval queue (1st Mate) — the case / revision / geometry model.
//
// Projections of the announcement pathway, not a second ingest: the Flowcore
// events are the durable record and every row here can be rebuilt by replaying
// them. One CASE per law/notice; N GEOMETRY records per case (a legal amendment
// may change dates without touching a polygon, a later notice may replace the
// polygon without duplicating the legal record); one REVISION per observed
// version of the source text, addressable so an approval can name exactly what
// it approved.
//
// The three status axes are deliberately separate columns and must not be
// collapsed: what the REGULATION is (draft → published → replaced), where the
// ADMIN CASE sits in the inbox workflow, and how this record COMPARES to other
// sources of the same regulation are independent facts. The two validation
// flags (regulatory / geometry) sit beside them and are only ever written
// false by ingestion — flipping them is stage ②'s approval, a human act.
// ---------------------------------------------------------------------------

export const regulationCases = pgTable(
  "regulation_cases",
  {
    // Deterministic (derived from `case_key`), so a replay rebuilds the same
    // ids and references from other systems survive the rebuild.
    id: text("id").primaryKey(),
    // `${sourceType}:${sourceRef}` — the source's own identity for the
    // regulation, e.g. `fiskeridir-jmelding:J-39-2026`. The idempotency anchor.
    caseKey: text("case_key").notNull(),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    // Identity block (§4). Authority and regulation number are nullable —
    // a metadata-only case is a valid case.
    title: text("title").notNull(),
    authority: text("authority"),
    regulationNumber: text("regulation_number"),
    sourceUrl: text("source_url").notNull(),
    category: text("category"),
    summary: text("summary"),
    // Applicability block (§4) — queryable structure, never free text, so
    // "Applicability differs" can be computed between two records. Shape is
    // `regulationApplicabilitySchema`; null until an extraction fills it.
    applicability: jsonb("applicability"),
    // Time block (§4). What the source called its own validity is kept in
    // `source_status` verbatim; the instants are normalised for reads.
    sourceStatus: text("source_status").notNull().default("unknown"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    seasonalRecurrence: text("seasonal_recurrence"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Change taxonomy, not CRUD verbs: new | amendment | replacement |
    // reopening | expiry.
    changeType: text("change_type").notNull().default("new"),
    // Stage ⑤ headroom: ingested | mismatch | customer_report | expiry.
    caseType: text("case_type").notNull().default("ingested"),
    evidence: jsonb("evidence"),
    // Status axis 1 — the regulation:
    // draft | validated | published | replaced | expired.
    regulationStatus: text("regulation_status").notNull().default("draft"),
    // Status axis 2 — the admin case (§12 inbox):
    // unread | under_review | awaiting_information |
    // awaiting_regulatory_validation | awaiting_geometry_validation |
    // approved | published | rejected | duplicate | expired.
    adminStatus: text("admin_status").notNull().default("unread"),
    // Status axis 3 — source comparison (§9): matched | newer_than_operational
    // | geometry_differs | applicability_differs | missing_legal_reference |
    // replaced_expired. Null until a second source exists to compare against.
    sourceComparison: text("source_comparison"),
    // The two validation flags. Ingestion only ever writes false.
    regulatoryValidated: boolean("regulatory_validated")
      .notNull()
      .default(false),
    geometryValidated: boolean("geometry_validated").notNull().default(false),
    // Verdict state of the CURRENT revision, mirrored here for queue queries:
    // pending | ok | failed. The verdict itself lives on the revision.
    verdictStatus: text("verdict_status").notNull().default("pending"),
    // Provenance block (§4).
    detectedBy: text("detected_by").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", {
      withTimezone: true,
    }).notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    interpretationNotes: text("interpretation_notes"),
    // §12 inbox fields — stage ② UI, stage ① columns.
    assignee: text("assignee"),
    isRead: boolean("is_read").notNull().default(false),
    urgency: text("urgency"),
    snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
    duplicateOfCaseId: text("duplicate_of_case_id"),
    currentRevisionId: text("current_revision_id").notNull(),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseKeyIdx: uniqueIndex("regulation_cases_case_key_idx").on(table.caseKey),
    adminStatusIdx: index("regulation_cases_admin_status_idx").on(
      table.adminStatus,
    ),
    jurisdictionIdx: index("regulation_cases_jurisdiction_idx").on(
      table.jurisdiction,
    ),
    verdictStatusIdx: index("regulation_cases_verdict_status_idx").on(
      table.verdictStatus,
    ),
  }),
);

export const regulationCaseRevisions = pgTable(
  "regulation_case_revisions",
  {
    // Deterministic (derived from the announcement signature), so approvals
    // that name a revision id survive a projection rebuild.
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    // 0-based, in observation order. The current revision is the case's
    // `current_revision_id`, not max(position) — a rollback stays addressable.
    position: integer("position").notNull(),
    contentHash: text("content_hash"),
    changeType: text("change_type").notNull(),
    // Who produced this revision: `collector:<job id>` now, `agent` and
    // `admin:<user>` in stage ②.
    author: text("author").notNull(),
    // The raw source snapshot (§4 Provenance, decision 6): what was actually
    // parsed, kept so geometry can be re-parsed after a parser or POI fix
    // without re-fetching a source that may have changed or vanished.
    // PostgreSQL is canonical for this. For Lógasavn statutes the body rides
    // in the corpus fragment `snapshot_fragment_id` points at; the text lands
    // here too the first time a reader fetches it.
    snapshotText: text("snapshot_text"),
    snapshotUrl: text("snapshot_url").notNull(),
    snapshotFetchedAt: timestamp("snapshot_fetched_at", { withTimezone: true }),
    snapshotFragmentId: text("snapshot_fragment_id"),
    parserVersion: text("parser_version"),
    // Parse failure is a case state, not an exception: a document that failed
    // to parse is a case a human needs to see, never a dropped record.
    parseStatus: text("parse_status").notNull().default("ok"),
    parseError: text("parse_error"),
    // The structured verdict for THIS text: pending | ok | failed. `failed`
    // means the model's answer did not validate against the issue schema —
    // the verdict fails closed as a state, never as a crash.
    verdictStatus: text("verdict_status").notNull().default("pending"),
    verdict: jsonb("verdict"),
    // Why a failed verdict failed. Its own column: `parse_error` belongs to
    // the parse stage, and a revision can fail both — each diagnostic must
    // survive the other.
    verdictError: text("verdict_error"),
    verdictModel: text("verdict_model"),
    verdictConfidence: doublePrecision("verdict_confidence"),
    verdictRecordedAt: timestamp("verdict_recorded_at", { withTimezone: true }),
    sourceEventSignature: text("source_event_signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    casePositionIdx: uniqueIndex(
      "regulation_case_revisions_case_position_idx",
    ).on(table.caseId, table.position),
    caseIdx: index("regulation_case_revisions_case_idx").on(table.caseId),
  }),
);

export const regulationCaseGeometries = pgTable(
  "regulation_case_geometries",
  {
    // Deterministic (revision id + position) — geometry validation in stage ②
    // is per-area, so each area must stay addressable across rebuilds.
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    revisionId: text("revision_id").notNull(),
    position: integer("position").notNull(),
    name: text("name"),
    section: text("section"),
    // closure | exemption | other — only closures are ever drawn.
    kind: text("kind").notNull().default("closure"),
    season: text("season"),
    // The coordinates as the source printed them, verbatim, when the pipeline
    // that produced this geometry carried them (the statute reader quotes
    // vertices character-for-character). Null for collectors that emit parsed
    // points only.
    verticesQuoted: jsonb("vertices_quoted"),
    // Parsed vertices, `[{lat, lon}]`, in source order — the vertex SET, not an
    // interpretation of it. Closing an open run into a polygon would be derived
    // geometry, which this pipeline never does; hence `geom` is a MultiPoint,
    // the same deliberate choice `jmelding_geo` made.
    points: jsonb("points").notNull(),
    geom: geometryMultiPoint("geom"),
    // enumerated (vertex list in the source) | preparsed (collector-supplied
    // points) | described (boundary defined by bearings / bands / references —
    // flagged, never computed).
    geometrySource: text("geometry_source").notNull().default("preparsed"),
    coordinateSystem: text("coordinate_system").notNull().default("WGS84"),
    precision: text("precision"),
    geometryValidated: boolean("geometry_validated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    revisionIdx: index("regulation_case_geometries_revision_idx").on(
      table.revisionId,
    ),
    caseIdx: index("regulation_case_geometries_case_idx").on(table.caseId),
    geomGistIdx: index("regulation_case_geometries_geom_gist_idx").using(
      "gist",
      table.geom,
    ),
  }),
);

// One row per source that vouches for a case. The primary source creates the
// case; §9 requires that a second source arriving later (e.g. BarentsWatch
// after a J-melding) is ATTACHED and compared, never turned into a rival case.
// The attach itself will be an event when the matcher exists — this table is
// the shape it lands in.
export const regulationCaseSources = pgTable(
  "regulation_case_sources",
  {
    caseId: text("case_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref").notNull(),
    url: text("url"),
    isPrimary: boolean("is_primary").notNull().default(false),
    // Source-comparison state for THIS attachment (§9) — null on the primary.
    comparison: text("comparison"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", {
      withTimezone: true,
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.caseId, table.sourceType, table.sourceRef],
    }),
  }),
);

// Replacement and repeal links, explicit and bidirectional by construction:
// a row `A replaces B` answers both "what did A replace" and "what replaced
// B". `target_case_id` stays null until the target is itself a case.
export const regulationCaseLinks = pgTable(
  "regulation_case_links",
  {
    caseId: text("case_id").notNull(),
    // replaces | repeals
    kind: text("kind").notNull(),
    targetCaseKey: text("target_case_key").notNull(),
    targetCaseId: text("target_case_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.caseId, table.kind, table.targetCaseKey],
    }),
    targetIdx: index("regulation_case_links_target_idx").on(
      table.targetCaseKey,
    ),
  }),
);

// Append-only projection of `regulation.case.admin-action.recorded.0` — the
// audit trail the case-detail screen lists. The id is the event's actionId,
// so a replay re-lands the same row (insert … on conflict do nothing) and
// the log never doubles.
export const regulationCaseActions = pgTable(
  "regulation_case_actions",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    // The discriminant (`mark_read`, `assign`, …) lifted out of the payload
    // so the log is filterable without opening jsonb.
    kind: text("kind").notNull(),
    // The full action union member, verbatim from the event.
    action: jsonb("action").notNull(),
    // `admin:<username>` — stamped by the route from the auth token.
    actor: text("actor").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseIdx: index("regulation_case_actions_case_idx").on(
      table.caseId,
      table.recordedAt,
    ),
  }),
);
