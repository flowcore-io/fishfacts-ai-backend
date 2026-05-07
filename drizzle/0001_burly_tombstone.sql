CREATE TABLE "jmelding_chunk_queue" (
	"signature" text NOT NULL,
	"part_number" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jmelding_chunk_queue_signature_part_number_pk" PRIMARY KEY("signature","part_number")
);
--> statement-breakpoint
CREATE INDEX "jmelding_chunk_queue_created_at_idx" ON "jmelding_chunk_queue" USING btree ("created_at");