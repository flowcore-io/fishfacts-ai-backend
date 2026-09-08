ALTER TABLE "regulation_cases" ADD COLUMN "published_revision_id" text;--> statement-breakpoint
ALTER TABLE "regulation_cases" ADD COLUMN "published_to_users_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "regulation_cases" ADD COLUMN "published_to_users_by" text;--> statement-breakpoint
ALTER TABLE "regulation_cases" ADD COLUMN "published_metadata_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "regulation_cases_published_idx" ON "regulation_cases" USING btree ("jurisdiction") WHERE published_revision_id IS NOT NULL;--> statement-breakpoint
-- Stage ③ backfill, replay-equivalent: the projector now derives the
-- published lane from `approval.recorded.0` (approval IS the publish), so
-- cases approved under stage ② must land exactly where a projection replay
-- of their events would put them. Latest APPLIED approval pins the pointer;
-- a case declined since (rejected/duplicate) stays un-published, and a case
-- redrafted since keeps its review lane but pins the approved revision.
UPDATE regulation_cases c
SET published_revision_id = a.revision_id,
    published_to_users_at = a.recorded_at,
    published_to_users_by = a.actor,
    published_metadata_only = a.metadata_only,
    regulation_status = 'published',
    admin_status = CASE WHEN c.admin_status = 'approved' THEN 'published' ELSE c.admin_status END
FROM (
  SELECT DISTINCT ON (case_id) case_id, revision_id, recorded_at, actor, metadata_only
  FROM regulation_case_approvals
  WHERE applied
  ORDER BY case_id, recorded_at DESC
) a
WHERE c.id = a.case_id AND c.admin_status NOT IN ('rejected', 'duplicate');
