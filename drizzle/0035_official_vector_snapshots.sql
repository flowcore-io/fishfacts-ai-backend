CREATE TABLE "regulation_official_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_revision_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"base_revision_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"actor" text NOT NULL,
	"payload_hash" text NOT NULL,
	"parts" jsonb NOT NULL,
	"event_ids" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regulation_case_geometries" ADD COLUMN "paragraph" integer;--> statement-breakpoint
ALTER TABLE "regulation_case_geometries" ADD COLUMN "official_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "regulation_case_geometries" ADD COLUMN "evidence_runs" jsonb;--> statement-breakpoint
ALTER TABLE "regulation_case_official_areas" ADD COLUMN "source_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "regulation_case_validations" ADD COLUMN "official_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "regulation_case_validations" ADD COLUMN "geometry_hash" text;