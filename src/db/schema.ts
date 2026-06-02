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
