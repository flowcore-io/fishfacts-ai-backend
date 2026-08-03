--> IF EXISTS is added by hand. Migrations run at boot under a top-level await
--> (src/index.ts), so a DROP of a table someone already removed by hand does not
--> merely fail — it takes the service down with it.
DROP TABLE IF EXISTS "logasavn_review" CASCADE;