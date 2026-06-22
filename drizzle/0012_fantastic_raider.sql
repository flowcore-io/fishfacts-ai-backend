CREATE TABLE "job_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"args" jsonb,
	"error" text,
	"duration_ms" bigint,
	"changed" boolean
);
--> statement-breakpoint
CREATE TABLE "job_state" (
	"job_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_status" text DEFAULT 'idle' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"last_duration_ms" bigint,
	"listing_fingerprint" text,
	"cursor" jsonb,
	"progress" jsonb,
	"latest_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{"runs":0,"successes":0,"failures":0,"newDataEvents":0}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "job_runs_job_id_started_at_idx" ON "job_runs" USING btree ("job_id","started_at");