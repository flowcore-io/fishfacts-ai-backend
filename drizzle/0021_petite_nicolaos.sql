CREATE TABLE "regulation_case_geometries" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text,
	"section" text,
	"kind" text DEFAULT 'closure' NOT NULL,
	"season" text,
	"vertices_quoted" jsonb,
	"points" jsonb NOT NULL,
	"geom" geometry(MultiPoint, 4326),
	"geometry_source" text DEFAULT 'preparsed' NOT NULL,
	"coordinate_system" text DEFAULT 'WGS84' NOT NULL,
	"precision" text,
	"geometry_validated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_case_links" (
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_case_key" text NOT NULL,
	"target_case_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regulation_case_links_case_id_kind_target_case_key_pk" PRIMARY KEY("case_id","kind","target_case_key")
);
--> statement-breakpoint
CREATE TABLE "regulation_case_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"position" integer NOT NULL,
	"content_hash" text,
	"change_type" text NOT NULL,
	"author" text NOT NULL,
	"snapshot_text" text,
	"snapshot_url" text NOT NULL,
	"snapshot_fetched_at" timestamp with time zone,
	"snapshot_fragment_id" text,
	"parser_version" text,
	"parse_status" text DEFAULT 'ok' NOT NULL,
	"parse_error" text,
	"verdict_status" text DEFAULT 'pending' NOT NULL,
	"verdict" jsonb,
	"verdict_model" text,
	"verdict_confidence" double precision,
	"verdict_recorded_at" timestamp with time zone,
	"source_event_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_case_sources" (
	"case_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"url" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"comparison" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "regulation_case_sources_case_id_source_type_source_ref_pk" PRIMARY KEY("case_id","source_type","source_ref")
);
--> statement-breakpoint
CREATE TABLE "regulation_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"case_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"title" text NOT NULL,
	"authority" text,
	"regulation_number" text,
	"source_url" text NOT NULL,
	"category" text,
	"summary" text,
	"applicability" jsonb,
	"source_status" text DEFAULT 'unknown' NOT NULL,
	"published_at" timestamp with time zone,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"seasonal_recurrence" text,
	"expires_at" timestamp with time zone,
	"change_type" text DEFAULT 'new' NOT NULL,
	"case_type" text DEFAULT 'ingested' NOT NULL,
	"evidence" jsonb,
	"regulation_status" text DEFAULT 'draft' NOT NULL,
	"admin_status" text DEFAULT 'unread' NOT NULL,
	"source_comparison" text,
	"regulatory_validated" boolean DEFAULT false NOT NULL,
	"geometry_validated" boolean DEFAULT false NOT NULL,
	"verdict_status" text DEFAULT 'pending' NOT NULL,
	"detected_by" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone,
	"interpretation_notes" text,
	"assignee" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"urgency" text,
	"snooze_until" timestamp with time zone,
	"duplicate_of_case_id" text,
	"current_revision_id" text NOT NULL,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "regulation_case_geometries_revision_idx" ON "regulation_case_geometries" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "regulation_case_geometries_case_idx" ON "regulation_case_geometries" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "regulation_case_geometries_geom_gist_idx" ON "regulation_case_geometries" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "regulation_case_links_target_idx" ON "regulation_case_links" USING btree ("target_case_key");--> statement-breakpoint
CREATE UNIQUE INDEX "regulation_case_revisions_case_position_idx" ON "regulation_case_revisions" USING btree ("case_id","position");--> statement-breakpoint
CREATE INDEX "regulation_case_revisions_case_idx" ON "regulation_case_revisions" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regulation_cases_case_key_idx" ON "regulation_cases" USING btree ("case_key");--> statement-breakpoint
CREATE INDEX "regulation_cases_admin_status_idx" ON "regulation_cases" USING btree ("admin_status");--> statement-breakpoint
CREATE INDEX "regulation_cases_jurisdiction_idx" ON "regulation_cases" USING btree ("jurisdiction");--> statement-breakpoint
CREATE INDEX "regulation_cases_verdict_status_idx" ON "regulation_cases" USING btree ("verdict_status");