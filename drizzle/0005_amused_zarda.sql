CREATE TABLE "ais_backfill_buckets" (
	"bucket_hour" timestamp with time zone PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_ts" timestamp with time zone,
	"last_id" bigint,
	"source_count" bigint,
	"emitted_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ais_ingest_state" (
	"id" text PRIMARY KEY NOT NULL,
	"start_at" timestamp with time zone,
	"cursor" jsonb,
	"emitted_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ais_backfill_buckets_status_idx" ON "ais_backfill_buckets" USING btree ("status");