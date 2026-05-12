CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "jmelding_geo" (
	"jm_number" text PRIMARY KEY NOT NULL,
	"fragment_key" text NOT NULL,
	"fragment_id" text,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"url" text NOT NULL,
	"signature" text NOT NULL,
	"has_geo" boolean DEFAULT false NOT NULL,
	"areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"geojson" jsonb,
	"geom" geometry(MultiPoint, 4326),
	"min_lat" double precision,
	"max_lat" double precision,
	"min_lon" double precision,
	"max_lon" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jmelding_geo_geom_gist_idx" ON "jmelding_geo" USING GIST ("geom");
--> statement-breakpoint
CREATE INDEX "jmelding_geo_status_idx" ON "jmelding_geo" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "jmelding_geo_has_geo_idx" ON "jmelding_geo" USING btree ("has_geo");
--> statement-breakpoint
CREATE INDEX "jmelding_geo_fragment_key_idx" ON "jmelding_geo" USING btree ("fragment_key");
