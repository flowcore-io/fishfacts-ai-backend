import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
