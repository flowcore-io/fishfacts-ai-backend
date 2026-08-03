CREATE TABLE "logasavn_review" (
	"fragment_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"title" text NOT NULL,
	"authority" text,
	"validity_status" text,
	"coordinate_like" integer DEFAULT 0 NOT NULL,
	"ring_count" integer DEFAULT 0 NOT NULL,
	"vertex_count" integer DEFAULT 0 NOT NULL,
	"withheld_count" integer DEFAULT 0 NOT NULL,
	"detectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"review_reason" text NOT NULL,
	"recurrence" jsonb,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"decline_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logasavn_review_fragment_id_content_hash_pk" PRIMARY KEY("fragment_id","content_hash")
);
--> statement-breakpoint
CREATE INDEX "logasavn_review_status_idx" ON "logasavn_review" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "logasavn_review_current_idx" ON "logasavn_review" USING btree ("is_current","review_status");