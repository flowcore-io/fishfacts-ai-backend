CREATE TABLE "regulation_groups" (
	"group_id" text PRIMARY KEY NOT NULL,
	"jurisdiction" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "regulation_groups_jurisdiction_idx" ON "regulation_groups" USING btree ("jurisdiction","sort_order");