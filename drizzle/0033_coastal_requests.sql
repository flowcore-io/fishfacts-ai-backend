CREATE TABLE "regulation_reconstruction_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"base_revision_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"actor" text NOT NULL,
	"input_hash" text NOT NULL,
	"intent" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" jsonb,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "regulation_reconstruction_requests_pending_idx" ON "regulation_reconstruction_requests" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "regulation_reconstruction_requests_case_idx" ON "regulation_reconstruction_requests" USING btree ("case_id","id");