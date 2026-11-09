CREATE TABLE "ais_activity_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"body_gz" "bytea" NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_hit_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ais_activity_cache_last_hit_at_idx" ON "ais_activity_cache" USING btree ("last_hit_at");