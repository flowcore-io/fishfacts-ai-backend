CREATE TABLE IF NOT EXISTS "areas" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"group_name" text,
	"geometry_type" text NOT NULL,
	"geometry" jsonb NOT NULL,
	"color" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"source_event_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_areas_deleted_at_idx" ON "areas" USING btree ("deleted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_areas_name_idx" ON "areas" USING btree ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_areas_group_name_idx" ON "areas" USING btree ("group_name");
--> statement-breakpoint
ALTER TABLE "sildelaget_catch_lines" ADD COLUMN IF NOT EXISTS "route_key" text;
--> statement-breakpoint
ALTER TABLE "sildelaget_catch_lines" ADD COLUMN IF NOT EXISTS "route_fao_area" text;
--> statement-breakpoint
ALTER TABLE "sildelaget_catch_lines" ADD COLUMN IF NOT EXISTS "route_center_latitude" double precision;
--> statement-breakpoint
ALTER TABLE "sildelaget_catch_lines" ADD COLUMN IF NOT EXISTS "route_center_longitude" double precision;
--> statement-breakpoint
ALTER TABLE "sildelaget_catch_lines" ADD COLUMN IF NOT EXISTS "route_coordinates" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sildelaget_catch_lines_route_key_idx" ON "sildelaget_catch_lines" USING btree ("route_key");
