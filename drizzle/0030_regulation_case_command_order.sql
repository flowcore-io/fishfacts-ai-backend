CREATE TABLE "regulation_command_deliveries" (
	"command_id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"predecessor_command_id" text,
	"input_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"parts" jsonb NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"event_ids" jsonb
);
--> statement-breakpoint
CREATE TABLE "regulation_command_envelopes" (
	"command_id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"predecessor_command_id" text,
	"payload_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulation_command_receipts" (
	"command_id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"payload_hash" text NOT NULL,
	"command" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "regulation_command_tails" (
	"case_id" text PRIMARY KEY NOT NULL,
	"sequence" bigint NOT NULL,
	"command_id" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "regulation_command_deliveries_sequence_idx" ON "regulation_command_deliveries" USING btree ("case_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "regulation_command_envelopes_sequence_idx" ON "regulation_command_envelopes" USING btree ("case_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "regulation_command_receipts_sequence_idx" ON "regulation_command_receipts" USING btree ("case_id","sequence");