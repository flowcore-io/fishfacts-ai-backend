ALTER TABLE "jmelding_geo" ADD COLUMN "region" text DEFAULT 'NO' NOT NULL;--> statement-breakpoint
CREATE INDEX "jmelding_geo_region_idx" ON "jmelding_geo" USING btree ("region");