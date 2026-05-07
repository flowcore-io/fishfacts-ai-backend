import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
