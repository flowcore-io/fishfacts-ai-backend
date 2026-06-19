CREATE TABLE "gillnet_positions" (
	"call_sign" text PRIMARY KEY NOT NULL,
	"vessel_name" text NOT NULL,
	"gear_type" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"last_updated_at" timestamp with time zone,
	"nets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"geom" geometry(MultiLineString, 4326),
	"min_lat" double precision,
	"max_lat" double precision,
	"min_lon" double precision,
	"max_lon" double precision,
	"source_event_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gillnet_positions_snapshot_idx" ON "gillnet_positions" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "gillnet_positions_geom_gist_idx" ON "gillnet_positions" USING gist ("geom");