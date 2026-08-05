--> IF NOT EXISTS is added by hand, as in 0018. Migrations run at boot under a
--> top-level await (src/index.ts), so re-adding a column that already exists
--> does not merely fail — it takes the service down with it.
ALTER TABLE "jmelding_geo" ADD COLUMN IF NOT EXISTS "summary" text;