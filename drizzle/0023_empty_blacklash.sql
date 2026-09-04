CREATE TABLE "regulation_case_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"action" jsonb NOT NULL,
	"actor" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "regulation_case_actions_case_idx" ON "regulation_case_actions" USING btree ("case_id","recorded_at");