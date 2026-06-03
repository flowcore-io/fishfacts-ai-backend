CREATE TABLE "sildelaget_catch_entries" (
	"innmelding_id" text PRIMARY KEY NOT NULL,
	"reported_date" text,
	"reported_time" text,
	"vessel_name" text,
	"registration_mark" text,
	"entry_hash" text NOT NULL,
	"source_url" text NOT NULL,
	"raw_entry" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_event_id" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sildelaget_catch_lines" (
	"line_key" text PRIMARY KEY NOT NULL,
	"innmelding_id" text NOT NULL,
	"line_index" integer NOT NULL,
	"fishing_start_date" text,
	"fishing_start_time" text,
	"species" text,
	"tonnes" double precision,
	"weight_kg" double precision,
	"average" double precision,
	"catch_type" text,
	"sales_type" text,
	"gear" text,
	"route" text,
	"use" text,
	"pct1" double precision,
	"pct2" double precision,
	"pct3" double precision,
	"pct4" double precision,
	"assortment" text,
	"offer_east_south" text,
	"offer_east_south_date" text,
	"offer_east_south_time" text,
	"offer_east_north" text,
	"offer_east_north_date" text,
	"offer_east_north_time" text,
	"offer_west_south" text,
	"offer_west_south_date" text,
	"offer_west_south_time" text,
	"offer_west_north" text,
	"offer_west_north_date" text,
	"offer_west_north_time" text,
	"leased_vessel" text,
	"economic_zone" text,
	"municipality" text,
	"co_fisher" text,
	"buyer" text,
	"receiver" text,
	"nationality" text,
	"raw_row" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sildelaget_catch_entries_reported_date_idx" ON "sildelaget_catch_entries" USING btree ("reported_date");--> statement-breakpoint
CREATE INDEX "sildelaget_catch_entries_vessel_name_idx" ON "sildelaget_catch_entries" USING btree ("vessel_name");--> statement-breakpoint
CREATE INDEX "sildelaget_catch_entries_registration_mark_idx" ON "sildelaget_catch_entries" USING btree ("registration_mark");--> statement-breakpoint
CREATE INDEX "sildelaget_catch_lines_innmelding_id_idx" ON "sildelaget_catch_lines" USING btree ("innmelding_id");--> statement-breakpoint
CREATE INDEX "sildelaget_catch_lines_species_idx" ON "sildelaget_catch_lines" USING btree ("species");
