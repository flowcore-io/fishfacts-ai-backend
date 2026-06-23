CREATE TABLE "gebco_features" (
	"feature_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"feature_type" text NOT NULL,
	"geometry_type" text NOT NULL,
	"geom" geometry(Geometry, 4326),
	"centroid_lat" double precision,
	"centroid_lon" double precision,
	"min_lat" double precision,
	"max_lat" double precision,
	"min_lon" double precision,
	"max_lon" double precision,
	"source_event_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gebco_features_geom_gist_idx" ON "gebco_features" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "gebco_features_name_idx" ON "gebco_features" USING btree ("name");