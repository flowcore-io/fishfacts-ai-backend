ALTER TABLE "regulation_case_approvals" ADD COLUMN "approval_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "regulation_case_approvals" ADD COLUMN "shape_manifest_hash" text;--> statement-breakpoint
ALTER TABLE "regulation_case_approvals" ADD COLUMN "command_sequence" bigint;--> statement-breakpoint
ALTER TABLE "regulation_case_revisions" ADD COLUMN "geometry_model_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "regulation_case_revisions" ADD COLUMN "shape_state" jsonb;--> statement-breakpoint
ALTER TABLE "regulation_case_validations" ADD COLUMN "shape_id" text;--> statement-breakpoint
ALTER TABLE "regulation_case_validations" ADD COLUMN "shape_hash" text;--> statement-breakpoint
ALTER TABLE "regulation_case_validations" ADD COLUMN "coverage_hash" text;--> statement-breakpoint
ALTER TABLE "regulation_case_validations" ADD COLUMN "command_sequence" bigint;--> statement-breakpoint
ALTER TABLE "regulation_cases" ADD COLUMN "geometry_model_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "jmelding_geo" ADD COLUMN "live_source_signature" jsonb;
--> statement-breakpoint
CREATE TABLE "regulation_command_barriers" (
	"id" text PRIMARY KEY NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_ordered_inputs" (
	"observation_order" bigserial NOT NULL,
	"predecessor_input_id" text,
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"input_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regulation_case_revisions" ADD COLUMN "source_text_complete" boolean;--> statement-breakpoint
CREATE INDEX "regulation_ordered_inputs_pending_idx" ON "regulation_ordered_inputs" USING btree ("case_id","status");
--> statement-breakpoint
ALTER TABLE "regulation_cases" ADD COLUMN "published_approval_id" text;--> statement-breakpoint
CREATE INDEX "jmelding_chunk_queue_source_ref_idx" ON "jmelding_chunk_queue" USING btree (("payload"->>'jmNumber'),coalesce("payload"->>'region','NO'));
--> statement-breakpoint
CREATE INDEX "regulation_ordered_inputs_ordered_pending_idx" ON "regulation_ordered_inputs" USING btree ("status","observation_order");

--> statement-breakpoint
CREATE INDEX "regulation_ordered_inputs_case_order_idx" ON "regulation_ordered_inputs" USING btree ("case_id","observation_order");
