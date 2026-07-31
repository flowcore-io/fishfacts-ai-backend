ALTER TABLE "jmelding_geo" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jmelding_geo" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jmelding_geo_valid_to_idx" ON "jmelding_geo" USING btree ("valid_to");