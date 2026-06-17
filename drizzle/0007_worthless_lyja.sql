ALTER TABLE "ais_backfill_buckets" ADD COLUMN "projection_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ais_backfill_buckets" ADD COLUMN "projected_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ais_backfill_buckets" ADD COLUMN "projected_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ais_backfill_buckets_projection_status_idx" ON "ais_backfill_buckets" USING btree ("projection_status");