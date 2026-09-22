-- ============================================================================
-- Where did the 2,194 orphaned camper records go?
--
-- The dry run of purge_orphaned_camp_data() reports 41 rows across 11 tables,
-- and NEITHER camp_people NOR camp_state_kv NOR camp_canteen_accounts is among
-- them. Those three are where the camper records and the $95 of balances lived.
-- So they are not orphaned any more, and the dry run cannot say why.
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
-- ONE STATEMENT ON PURPOSE. The SQL Editor only shows the result grid of the
-- LAST statement in a paste, so the first version of this file — four separate
-- SELECTs — threw away three quarters of its own answer.
--
-- READ ONLY. Nothing is created, changed or deleted. Worth running BEFORE
-- purge_orphaned_camp_data(true), so the 41 rows are not the only thing anyone
-- ever knew about the other 2,194.
-- ============================================================================

  -- ─── 1. the three tables, split by whether their camp still exists ────────
  SELECT '1 split by whether the camp still exists' AS part,
         'camp_people' AS item,
         jsonb_build_object(
           'camp_exists',      count(*) FILTER (WHERE EXISTS     (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
           'orphaned',         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
           'camps_referenced', count(DISTINCT x.camp_id)) AS result
    FROM public.camp_people x

UNION ALL
  SELECT '1 split by whether the camp still exists', 'camp_state_kv',
         jsonb_build_object(
           'camp_exists',      count(*) FILTER (WHERE EXISTS     (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
           'orphaned',         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
           'camps_referenced', count(DISTINCT x.camp_id))
    FROM public.camp_state_kv x

UNION ALL
  SELECT '1 split by whether the camp still exists', 'camp_canteen_accounts',
         jsonb_build_object(
           'camp_exists',      count(*) FILTER (WHERE EXISTS     (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
           'orphaned',         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)),
           'camps_referenced', count(DISTINCT x.camp_id))
    FROM public.camp_canteen_accounts x

UNION ALL
  -- ─── 2. how many camps there are, and where the money is sitting ──────────
  SELECT '2 totals', 'counts',
         jsonb_build_object(
           'camps_now',          (SELECT count(*) FROM public.camps),
           'registered_copies',  (SELECT count(*) FROM public.debug_copies),
           'camper_rows',        (SELECT count(*) FROM public.camp_people),
           'camper_rows_live',   (SELECT count(*) FROM public.camp_people WHERE deleted_at IS NULL),
           'canteen_balance_total',
               (SELECT round(COALESCE(sum(balance), 0), 2) FROM public.camp_canteen_accounts),
           'balance_in_camps_that_are_gone',
               (SELECT round(COALESCE(sum(a.balance), 0), 2)
                  FROM public.camp_canteen_accounts a
                 WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = a.camp_id)))

UNION ALL
  -- ─── 3. which of these tables Postgres itself now refuses to orphan ───────
  -- This is the part that dates the change. Migration 222 section 4 DROPPED and
  -- re-ADDED every foreign key to camps so it would cascade — and re-adding a
  -- foreign key VALIDATES it. So if camp_people or camp_state_kv carries one,
  -- 222 could not have applied at all while orphan rows were still there, which
  -- puts answer A strictly BEFORE 222 rather than after it.
  --
  -- An empty object means these tables never had a foreign key to camps, and
  -- the trigger 222 installed is the only thing keeping them in step.
  SELECT '3 foreign keys to camps', 'on delete',
         COALESCE(jsonb_object_agg(
                    child.relname || '.' || con.conname,
                    CASE con.confdeltype WHEN 'c' THEN 'CASCADE'
                                         WHEN 'n' THEN 'SET NULL'
                                         WHEN 'd' THEN 'SET DEFAULT'
                                         WHEN 'r' THEN 'RESTRICT'
                                         ELSE 'NO ACTION' END), '{}'::jsonb)
    FROM pg_constraint con
    JOIN pg_class     child ON child.oid = con.conrelid
    JOIN pg_namespace nsp   ON nsp.oid   = child.relnamespace
    JOIN pg_class     ref   ON ref.oid   = con.confrelid
   WHERE con.contype = 'f' AND nsp.nspname = 'public' AND ref.relname = 'camps'
     AND child.relname IN ('camp_people', 'camp_state_kv', 'camp_canteen_accounts',
                           'daily_schedules', 'rotation_counts', 'camp_users')

UNION ALL
  -- ─── 4. and the orphan rows, per camp ─────────────────────────────────────
  -- Already seen once: four camps, not forty-two, and not a camper or a balance
  -- among them. Kept so this reads empty after the purge.
  SELECT '4 orphan rows per camp', 'orphans',
         COALESCE((SELECT jsonb_object_agg(o.k, o.n)
                     FROM (SELECT 'camp_users/' || x.camp_id AS k, count(*) AS n
                             FROM public.camp_users x
                            WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)
                            GROUP BY x.camp_id
                           UNION ALL
                           SELECT 'link_parent_invites/' || x.camp_id, count(*)
                             FROM public.link_parent_invites x
                            WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)
                            GROUP BY x.camp_id
                           UNION ALL
                           SELECT 'link_messages/' || x.camp_id, count(*)
                             FROM public.link_messages x
                            WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)
                            GROUP BY x.camp_id
                           UNION ALL
                           SELECT 'schedule_versions/' || x.camp_id, count(*)
                             FROM public.schedule_versions x
                            WHERE NOT EXISTS (SELECT 1 FROM public.camps c WHERE c.id = x.camp_id)
                            GROUP BY x.camp_id) o),
                  '{}'::jsonb)

ORDER BY part, item;
