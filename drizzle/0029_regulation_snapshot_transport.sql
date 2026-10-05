CREATE TABLE "regulation_snapshot_assemblies" (
	"assembly_id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'staging' NOT NULL,
	"snapshot" jsonb,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "regulation_snapshot_parts" (
	"assembly_id" text NOT NULL,
	"part_number" integer NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "regulation_snapshot_parts_assembly_id_part_number_pk" PRIMARY KEY("assembly_id","part_number")
);
--> statement-breakpoint
CREATE INDEX "regulation_snapshot_assemblies_case_idx" ON "regulation_snapshot_assemblies" USING btree ("case_id");