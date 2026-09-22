-- ============================================================================
-- Where did the 2,194 orphaned camper records go?
--
-- The dry run of purge_orphaned_camp_data() now reports 41 rows across 11
-- tables, and NEITHER camp_people NOR camp_state_kv NOR camp_canteen_accounts
-- is among them. Those three are where the camper records and the $95 of
-- balances lived. So they are not orphaned any more, and the dry run cannot say
-- why.
--
-- There are only two ways that is true, and they mean opposite things:
--
--   A. The rows are gone.   Something removed them between the measurement and
--                           now. Nothing left to repair.
--   B. The camps are back.  The camp_ids resolve because a camps row exists —
--                           i.e. those camps were never deleted, and what we
--                           measured was never orphan data. Also nothing to
--                           repair, but it changes the story.
--
-- This tells you which. READ ONLY — four SELECTs, nothing is changed.
-- Worth running BEFORE purge_orphaned_camp_data(true), so the 41 rows are not
-- the only thing you ever knew about the other 2,194.
-- ============================================================================

-- ─── 1. the three tables, split by whether their camp still exists ──────────
SELECT 'camp_people'          AS tbl,
       count(*) FILTER (WHERE EXISTS     (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)) AS camp_exists,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)) AS orphaned,
       count(DISTINCT x.camp_id) AS camps_referenced
  FROM public.camp_people x
UNION ALL
SELECT 'camp_state_kv',
       count(*) FILTER (WHERE EXISTS     (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
       count(DISTINCT x.camp_id)
  FROM public.camp_state_kv x
UNION ALL
SELECT 'camp_canteen_accounts',
       count(*) FILTER (WHERE EXISTS     (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
       count(DISTINCT x.camp_id)
  FROM public.camp_canteen_accounts x;


-- ─── 2. how many camps there are, and where the money is sitting ────────────
SELECT (SELECT count(*) FROM public.camps)                          AS camps_now,
       (SELECT count(*) FROM public.debug_copies)                   AS registered_copies,
       (SELECT count(*) FROM public.camp_people)                    AS camper_rows,
       (SELECT count(*) FROM public.camp_people WHERE deleted_at IS NULL)
                                                                    AS camper_rows_live,
       (SELECT round(COALESCE(sum(balance), 0), 2)
          FROM public.camp_canteen_accounts)                        AS canteen_balance_total,
       (SELECT round(COALESCE(sum(a.balance), 0), 2)
          FROM public.camp_canteen_accounts a
         WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = a.camp_id))
                                                                    AS balance_in_camps_that_are_gone;


-- ─── 3. which of these tables Postgres itself now refuses to orphan ─────────
-- This is the part that dates the change. Migration 222 section 4 DROPPED and
-- re-ADDED every foreign key to camps so it would cascade — and re-adding a
-- foreign key VALIDATES it. So if camp_people or camp_state_kv carries one,
-- 222 could not have applied at all while orphan rows were still there, which
-- puts answer A strictly BEFORE 222 rather than after it.
--
-- An empty result here means these tables never had a foreign key to camps,
-- and the trigger 222 installed is the only thing keeping them in step.
SELECT child.relname                     AS table_name,
       con.conname                       AS constraint_name,
       CASE con.confdeltype WHEN 'c' THEN 'CASCADE'
                            WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT'
                            WHEN 'r' THEN 'RESTRICT'
                            ELSE 'NO ACTION' END AS on_delete
  FROM pg_constraint con
  JOIN pg_class     child ON child.oid = con.conrelid
  JOIN pg_namespace nsp   ON nsp.oid   = child.relnamespace
  JOIN pg_class     ref   ON ref.oid   = con.confrelid
 WHERE con.contype = 'f' AND nsp.nspname = 'public' AND ref.relname = 'camps'
   AND child.relname IN ('camp_people', 'camp_state_kv', 'camp_canteen_accounts',
                         'daily_schedules', 'rotation_counts', 'camp_users')
 ORDER BY child.relname;


-- ─── 4. and the 41 rows that ARE orphaned, with the camps they point at ─────
-- Small enough to just look at. Every one is a row the old delete path left
-- behind; none of them is a camper or a balance.
SELECT 'camp_users' AS tbl, x.camp_id, count(*) AS row_count FROM public.camp_users x
 WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id) GROUP BY x.camp_id
UNION ALL
SELECT 'link_parent_invites', x.camp_id, count(*) FROM public.link_parent_invites x
 WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id) GROUP BY x.camp_id
UNION ALL
SELECT 'link_messages', x.camp_id, count(*) FROM public.link_messages x
 WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id) GROUP BY x.camp_id
UNION ALL
SELECT 'schedule_versions', x.camp_id, count(*) FROM public.schedule_versions x
 WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id) GROUP BY x.camp_id
 ORDER BY 1, 2;
