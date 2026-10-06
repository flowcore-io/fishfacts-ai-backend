CREATE TABLE "regulation_land_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest" jsonb NOT NULL,
	"coverage" geometry(Geometry, 4326) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_land_features" (
	"dataset_id" text NOT NULL,
	"source_fid" bigint NOT NULL,
	"wkb_hex" text NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	CONSTRAINT "regulation_land_features_dataset_id_source_fid_pk" PRIMARY KEY("dataset_id","source_fid")
);
--> statement-breakpoint
ALTER TABLE "regulation_land_features" ADD CONSTRAINT "regulation_land_features_dataset_id_regulation_land_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."regulation_land_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "regulation_land_features_geometry_idx" ON "regulation_land_features" USING gist ("geom");