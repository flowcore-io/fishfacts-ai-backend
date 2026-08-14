--> IF EXISTS is added by hand, as in 0018/0020. Migrations run at boot under a
--> top-level await (src/index.ts), so dropping an index that is already gone
--> does not merely fail — it takes the service down with it.
-->
--> The index was created for the anchor retry clause, which cannot use it: the
--> clause ORs across both sides of a LEFT JOIN, so the planner reads the table
--> (Seq Scan, 66 ms at 20k entries x 20k anchors, once an hour).
DROP INDEX IF EXISTS "sildelaget_catch_ais_anchors_status_idx";
