CREATE TABLE "regulation_case_official_areas" (
	"case_id" text NOT NULL,
	"paragraph" integer NOT NULL,
	"name" text,
	"geojson" jsonb NOT NULL,
	"vertex_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"source" text DEFAULT 'fiskeridir-wfs' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regulation_case_official_areas_case_id_paragraph_pk" PRIMARY KEY("case_id","paragraph")
);
