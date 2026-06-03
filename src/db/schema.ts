import {
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
    geomGistIdx: index("jmelding_geo_geom_gist_idx").on(table.geom),
    statusIdx: index("jmelding_geo_status_idx").on(table.status),
    hasGeoIdx: index("jmelding_geo_has_geo_idx").on(table.hasGeo),
    fragmentKeyIdx: index("jmelding_geo_fragment_key_idx").on(
      table.fragmentKey,
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
  }),
);
