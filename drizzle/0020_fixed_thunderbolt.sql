--> IF NOT EXISTS is added by hand, as in 0018/0019. Migrations run at boot under
--> a top-level await (src/index.ts), so re-creating an object that already
--> exists does not merely fail — it takes the service down with it.
CREATE TABLE IF NOT EXISTS "sildelaget_catch_ais_anchors" (
	"innmelding_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"vessel_id" integer,
	"reported_at" timestamp with time zone,
	"reported_latitude" double precision,
	"reported_longitude" double precision,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"fix_count" integer DEFAULT 0 NOT NULL,
	"runs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sildelaget_catch_ais_anchors_status_idx" ON "sildelaget_catch_ais_anchors" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sildelaget_catch_ais_anchors_computed_at_idx" ON "sildelaget_catch_ais_anchors" USING btree ("computed_at");
