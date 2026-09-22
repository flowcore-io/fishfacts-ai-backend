CREATE TABLE "regulation_case_notes" (
	"note_id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"case_key" text NOT NULL,
	"text" text NOT NULL,
	"actor" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "regulation_case_notes_case_idx" ON "regulation_case_notes" USING btree ("case_id","recorded_at");