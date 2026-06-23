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
    signature: text("signature").notNull(),
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
