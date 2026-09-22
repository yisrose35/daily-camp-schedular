-- ============================================================================
-- Why 448 of 510 camper references cannot be resolved to a camper
--
-- verify_camper_ids() reports 510 rows naming a camper, 62 carrying an id, and
-- 448 the roster cannot resolve. The largest block by far is the canteen:
-- 353 of 373 accounts, holding $66.72 — which is the ENTIRE canteen balance in
-- the database. Every cent of canteen money is sitting on an account that
-- cannot be tied to a child.
--
-- 223 put the column, the index and the stamping trigger on all seventeen
-- tables, and the report confirms all of that is in place
-- ("tables_without_the_stamping_trigger": []). So the plumbing works. What is
-- failing is the LOOKUP: camp_person_by_name(camp_id, name) is returning NULL.
--
-- It can only return NULL for four reasons, and they call for four completely
-- different responses:
--
--   1. the camp has no roster at all   → camp_people was never projected for
--                                        that camp. Fix: backfill. No code
--                                        change, no risk, 353 rows resolve at
--                                        once.
--   2. the name is not in the roster   → the roster exists but this spelling
--                                        is not in it. Fix: find out what the
--                                        spellings actually are.
--   3. the name matches two campers    → deliberately NULL. 223 refuses to
--                                        guess between two children.
--   4. the name is blank               → nothing to resolve; the row is junk.
--
-- Guessing between these is how you end up attributing one child's money to
-- another, so this asks instead. READ ONLY, one statement, one grid.
-- ============================================================================

  -- ─── 1. the shape of the problem, per camp ────────────────────────────────
  -- Only camps that actually have canteen accounts. If roster_campers is 0 for
  -- the camps holding the 353, reason 1 is the whole answer and the fix is a
  -- backfill.
  SELECT '1 per camp' AS part, 'canteen vs roster' AS item,
         COALESCE(jsonb_object_agg(s.camp, s.detail), '{}'::jsonb) AS result
    FROM (SELECT a.camp_id::text AS camp,
                 jsonb_build_object(
                   'canteen_accounts',   count(*),
                   'resolved',           count(a.person_id),
                   'unresolved',         count(*) - count(a.person_id),
                   'balance_unresolved', round(COALESCE(sum(a.balance) FILTER (WHERE a.person_id IS NULL), 0), 2),
                   'roster_campers',     (SELECT count(*) FROM public.camp_people p
                                           WHERE p.camp_id = a.camp_id AND p.kind = 'camper'
                                             AND p.deleted_at IS NULL),
                   'camp_still_exists',  EXISTS (SELECT 1 FROM public.camps c WHERE c.id = a.camp_id)
                 ) AS detail
            FROM public.camp_canteen_accounts a
           WHERE a.deleted_at IS NULL
           GROUP BY a.camp_id) s

UNION ALL
  -- ─── 2. which of the four reasons, counted ────────────────────────────────
  -- The same three ranks camp_person_by_name uses, asked as a question instead
  -- of an answer. "two_or_more" is reason 3 and is CORRECT behaviour, not a bug.
  SELECT '2 why', 'unresolved canteen accounts',
         jsonb_build_object(
           'camp_has_no_roster', count(*) FILTER (
               WHERE NOT EXISTS (SELECT 1 FROM public.camp_people p
                                  WHERE p.camp_id = a.camp_id AND p.kind = 'camper'
                                    AND p.deleted_at IS NULL)),
           'name_not_in_roster', count(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM public.camp_people p
                              WHERE p.camp_id = a.camp_id AND p.kind = 'camper'
                                AND p.deleted_at IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM public.camp_people p
                                  WHERE p.camp_id = a.camp_id AND p.kind = 'camper'
                                    AND lower(btrim(p.source_key)) = lower(btrim(a.account_key)))),
           'name_matches_two_or_more', count(*) FILTER (
               WHERE (SELECT count(DISTINCT p.person_id) FROM public.camp_people p
                       WHERE p.camp_id = a.camp_id AND p.kind = 'camper'
                         AND lower(btrim(p.source_key)) = lower(btrim(a.account_key))) > 1),
           'blank_name', count(*) FILTER (WHERE NULLIF(btrim(COALESCE(a.account_key, '')), '') IS NULL))
    FROM public.camp_canteen_accounts a
   WHERE a.deleted_at IS NULL AND a.person_id IS NULL

UNION ALL
  -- ─── 3. what the unresolved keys actually look like ───────────────────────
  -- Twelve of them, biggest balances first. Read these next to part 4.
  SELECT '3 samples', 'unresolved account keys',
         COALESCE((SELECT jsonb_agg(e.ex)
                     FROM (SELECT jsonb_build_object('camp', left(a.camp_id::text, 8),
                                                     'account_key', a.account_key,
                                                     'camper_name', a.camper_name,
                                                     'balance', a.balance) AS ex
                             FROM public.camp_canteen_accounts a
                            WHERE a.deleted_at IS NULL AND a.person_id IS NULL
                            ORDER BY a.balance DESC NULLS LAST, a.account_key
                            LIMIT 12) e), '[]'::jsonb)

UNION ALL
  -- ─── 4. what the roster keys look like, in the same camps ─────────────────
  -- If part 3 reads "Levi Cohen" and this reads "levi-cohen", the answer is a
  -- spelling convention and no amount of backfilling will fix it. If this is
  -- empty, the roster is simply not there.
  SELECT '4 samples', 'roster keys in the same camps',
         COALESCE((SELECT jsonb_agg(e.ex)
                     FROM (SELECT DISTINCT jsonb_build_object('camp', left(p.camp_id::text, 8),
                                                              'source_key', p.source_key,
                                                              'name', p.name) AS ex
                             FROM public.camp_people p
                            WHERE p.kind = 'camper' AND p.deleted_at IS NULL
                              AND p.camp_id IN (SELECT DISTINCT a.camp_id
                                                  FROM public.camp_canteen_accounts a
                                                 WHERE a.deleted_at IS NULL)
                            LIMIT 12) e), '[]'::jsonb)

UNION ALL
  -- ─── 5. the 12 parent invite entries that name nobody ─────────────────────
  -- These are access, not money: verify_camper_ownership() reports 12 camper
  -- entries with a null id slot and 12 names with no camper. Same question.
  SELECT '5 access', 'invite names with no camper',
         COALESCE((SELECT jsonb_agg(e.ex)
                     FROM (SELECT jsonb_build_object(
                                    'camp', left(i.camp_id::text, 8),
                                    'name', nm.value #>> '{}',
                                    'roster_campers', (SELECT count(*) FROM public.camp_people p
                                                        WHERE p.camp_id = i.camp_id
                                                          AND p.kind = 'camper'
                                                          AND p.deleted_at IS NULL)) AS ex
                             FROM public.link_parent_invites i
                             CROSS JOIN LATERAL jsonb_array_elements(
                                 CASE WHEN jsonb_typeof(i.camper_names) = 'array'
                                      THEN i.camper_names ELSE '[]'::jsonb END) AS nm(value)
                            WHERE i.status = 'active'
                              AND (i.expires_at IS NULL OR i.expires_at > now())
                              AND public.camp_person_by_name(i.camp_id, nm.value #>> '{}') IS NULL
                            LIMIT 15) e), '[]'::jsonb)

UNION ALL
  -- ─── 6. and how many camps have a roster at all ───────────────────────────
  -- 38 camps exist. camp_people covers 12 of them. If the 26 without one are
  -- camps that hold data, a backfill is the next thing to run — and 216 already
  -- ships one: SELECT public.backfill_camp_people();
  SELECT '6 coverage', 'camps with and without a roster',
         jsonb_build_object(
           'camps', (SELECT count(*) FROM public.camps),
           'camps_with_a_camper_roster',
               (SELECT count(DISTINCT p.camp_id) FROM public.camp_people p
                 WHERE p.kind = 'camper' AND p.deleted_at IS NULL),
           'camps_with_campistryMe_saved',
               (SELECT count(DISTINCT k.camp_id) FROM public.camp_state_kv k
                 WHERE k.key = 'campistryMe'),
           'camps_with_campistryMe_but_no_roster',
               (SELECT count(*) FROM (
                   SELECT k.camp_id FROM public.camp_state_kv k
                    WHERE k.key = 'campistryMe'
                   EXCEPT
                   SELECT p.camp_id FROM public.camp_people p
                    WHERE p.kind = 'camper' AND p.deleted_at IS NULL) x))

ORDER BY part, item;
