CREATE TABLE "job_cron_claims" (
	"job_id" text NOT NULL,
	"bucket" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_cron_claims_job_id_bucket_pk" PRIMARY KEY("job_id","bucket")
);
--> statement-breakpoint
CREATE INDEX "job_cron_claims_claimed_at_idx" ON "job_cron_claims" USING btree ("claimed_at");