CREATE TABLE "regulation_case_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"metadata_only" boolean DEFAULT false NOT NULL,
	"note" text,
	"actor" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"applied" boolean NOT NULL,
	"refusal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_case_validations" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"scope" text NOT NULL,
	"geometry_id" text,
	"validated" boolean NOT NULL,
	"note" text,
	"actor" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regulation_case_revisions" ADD COLUMN "base_revision_id" text;--> statement-breakpoint
ALTER TABLE "regulation_case_revisions" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "regulation_case_revisions" ADD COLUMN "fields" jsonb;--> statement-breakpoint
CREATE INDEX "regulation_case_approvals_case_idx" ON "regulation_case_approvals" USING btree ("case_id","recorded_at");--> statement-breakpoint
CREATE INDEX "regulation_case_validations_case_idx" ON "regulation_case_validations" USING btree ("case_id","recorded_at");--> statement-breakpoint
CREATE INDEX "regulation_case_validations_revision_idx" ON "regulation_case_validations" USING btree ("revision_id");