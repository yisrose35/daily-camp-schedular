-- ============================================================================
-- Confirm migrations 222-236 are in and doing their job.
--
-- Paste the whole thing into the Supabase SQL Editor. It is READ ONLY — one
-- SELECT, nothing is created, changed or deleted, and the two purge functions
-- it calls are called in their DRY RUN form.
--
-- ONE STATEMENT ON PURPOSE. The SQL Editor only shows you the result grid of
-- the LAST statement in a paste. The first version of this file was three
-- separate SELECTs, so two thirds of the answer was silently thrown away before
-- anyone could read it. Everything is now a single UNION ALL and comes back as
-- one grid of (part, item, result).
--
-- The three parts:
--
--   1 is it there      — one row per migration. Anything other than "ok" means
--                        that file did not apply.
--   2 what it found    — the verifiers' own numbers. These are facts about your
--                        data, not pass/fail: some are MEANT to be non-zero.
--   3 what to do next  — the two destructive repairs, still un-run, each
--                        reporting the exact line to run once you have read it.
--
-- Safe to run as often as you like.
-- ============================================================================

  -- ─── 1. is it there ───────────────────────────────────────────────────────
  -- to_regprocedure returns NULL for a signature that does not exist instead of
  -- erroring, so a missing function reads as a row saying so rather than
  -- killing the whole query.
  SELECT '1 is it there' AS part, t.item, t.result
    FROM (VALUES
    ('222  deleting a camp deletes its data',
     CASE WHEN to_regprocedure('public.purge_camp_data(uuid)') IS NOT NULL
           AND to_regprocedure('public.verify_camp_deletion()') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                        WHERE c.relname = 'camps' AND tg.tgname = 'trg_purge_camp_data'
                          AND NOT tg.tgisinternal)
          THEN 'ok' ELSE 'MISSING — re-apply 222' END),

    ('223  every camper reference has an id',
     CASE WHEN to_regprocedure('public.camp_person_by_name(uuid,text)') IS NOT NULL
           AND to_regprocedure('public.verify_camper_ids()') IS NOT NULL
           AND NOT EXISTS (
                -- the assertion 223 makes about itself, asked again
                SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r'
                   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                                AND a.attname = 'camper_name' AND a.atttypid = 'text'::regtype
                                AND a.attnum > 0 AND NOT a.attisdropped)
                   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                                AND a.attname = 'camp_id' AND a.atttypid = 'uuid'::regtype
                                AND a.attnum > 0 AND NOT a.attisdropped)
                   AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                                    AND a.attname = 'person_id'
                                    AND a.attnum > 0 AND NOT a.attisdropped))
          THEN 'ok' ELSE 'MISSING — re-apply 223' END),

    ('224  parent access decided on ids',
     CASE WHEN to_regprocedure('public._parent_owns_person(uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public.verify_camper_ownership()') IS NOT NULL
          THEN 'ok' ELSE 'MISSING — re-apply 224' END),

    ('225  parent submissions filed against an id',
     CASE WHEN to_regprocedure('public.camp_person_label(uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public._parent_invite_for(uuid,bigint,text)') IS NOT NULL
           AND to_regprocedure('public.submit_health_document(uuid,text,text,text,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_pickup_request(text,text,jsonb,text,uuid,date,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text,text,bigint)') IS NOT NULL
           -- and 015's unscoped camper mail is gone
           AND to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text)') IS NULL
          THEN 'ok' ELSE 'MISSING or the stale overload survived — re-apply 225' END),

    ('226  face consent follows the child',
     CASE WHEN to_regprocedure('public.camper_face_consent(uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public.purge_revoked_face_data(boolean)') IS NOT NULL
           AND to_regprocedure('public.set_camper_face_consent(uuid,text,boolean,bigint)') IS NOT NULL
           -- and 028's unchecked headshot is gone
           AND to_regprocedure('public.submit_camper_headshot(uuid,text,text,jsonb)') IS NULL
          THEN 'ok' ELSE 'MISSING or the stale overload survived — re-apply 226' END),

    ('227  the canteen follows the person',
     CASE WHEN to_regprocedure('public.canteen_account_key_for(uuid,text)') IS NOT NULL
           AND to_regprocedure('public.verify_canteen_identity()') IS NOT NULL
           AND to_regprocedure('public.camp_parent_camper_ids(uuid)') IS NOT NULL
          THEN 'ok' ELSE 'MISSING — re-apply 227' END),

    ('228  no money RPC is ambiguous to PostgREST',
     CASE WHEN NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind = 'f'
               AND (p.proname LIKE '%canteen%' OR p.proname LIKE '%shop_order%')
             GROUP BY p.proname
            HAVING count(DISTINCT p.pronargs) > 1 AND bool_or(p.pronargdefaults > 0))
          THEN 'ok' ELSE 'STILL AMBIGUOUS — see the list in part 2' END),

    ('229  no writer returns on a variable set to NULL',
     CASE WHEN NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind = 'f'
               AND p.proname IN ('refund_canteen_deposit_from_processor',
                                 'refund_canteen_deposit_from_stripe',
                                 'merge_canteen_autoreload_card',
                                 'update_canteen_autoreload_state')
               AND p.prosrc ~ 'NULL::jsonb;')
          THEN 'ok' ELSE 'THE DEAD GUARD IS STILL THERE — re-apply 229' END),

    ('230  a shop order records what it took',
     CASE WHEN to_regprocedure('public.submit_shop_order(text,jsonb,text,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_shop_order(text,jsonb,text,text,text)') IS NULL
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'submit_shop_order'
                          AND p.prosrc ~ 'settlement')
          THEN 'ok' ELSE 'MISSING or the stale overload survived — re-apply 230' END),

    ('231  no writer asks the camper question itself',
     CASE WHEN to_regprocedure('public.submit_canteen_deposit(text,numeric,uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_canteen_deposit(text,numeric,uuid)') IS NULL
           AND to_regprocedure('public.set_canteen_limits(text,numeric,numeric,numeric,uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)') IS NOT NULL
           AND to_regprocedure('public.use_family_card_for_canteen_auto_reload(uuid,text,text,bigint)') IS NOT NULL
           -- None of 231's OWN functions still tests camper_names ? by hand.
           --
           -- Scoped deliberately. The first version of this row asked the
           -- camp-wide question, which made it read "re-apply 231" for a
           -- function 231 does not touch — get_my_shop_orders — so applying 231
           -- could never have turned this row green. A check that cannot pass is
           -- indistinguishable from a check that is failing, which is the same
           -- defect shape this whole chain is about. The camp-wide sweep has its
           -- own row in part 2, where a non-zero answer means "there is more to
           -- do", not "this file did not apply".
           AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND p.prokind = 'f'
                              AND p.proname IN ('submit_canteen_deposit', 'set_canteen_limits',
                                                'set_canteen_auto_reload',
                                                'use_family_card_for_canteen_auto_reload',
                                                '_admin_clear_stale_byop_cards')
                              AND p.prosrc ~ 'camper_names \?')
           -- And the two halves that were left on the campistrySnacks document are
           -- on rows.
           --
           -- ASKED AS WHAT THEY DO, not as what their text lacks. The first
           -- version of this looked for the bare string 'campistrySnacks'
           -- anywhere in prosrc — and prosrc includes COMMENTS, so it tripped on
           -- 231's own comment saying "On ROWS, not on campistrySnacks.accounts".
           -- The prose describing the repair read as the defect, and 231 reported
           -- MISSING for four applied migrations' worth of work. Third time
           -- today: the same mistake is in tests/migration_call_arity.test.js's
           -- history and in 233's first assertion.
           --
           -- So: neither function may still OPEN the document (key = '…' is how
           -- it is read and written, and no comment contains that), and both must
           -- call the row helpers. An absence is weak evidence; a presence is not.
           AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname IN ('use_family_card_for_canteen_auto_reload',
                                                '_admin_clear_stale_byop_cards')
                              AND p.prosrc ~ $re$key\s*=\s*'campistrySnacks'$re$)
           AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname IN ('use_family_card_for_canteen_auto_reload',
                                                '_admin_clear_stale_byop_cards')
                              AND p.prosrc !~ 'canteen_account_(lock|save)')
          THEN 'ok' ELSE 'MISSING — re-apply 231' END),

    ('232  an invite cannot inherit a stranger',
     CASE WHEN to_regprocedure('public.restamp_parent_invite(uuid)') IS NOT NULL
           AND to_regprocedure('public.parent_invites_needing_attention(uuid)') IS NOT NULL
           AND to_regprocedure('public.verify_parent_invite_identity()') IS NOT NULL
           AND EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'link_parent_invites'
                          AND column_name = 'person_ids_resolved_at')
           -- The bound is IN the gate. Checked by text because that is what a
           -- later edit removes; the behaviour is checked by
           -- scripts/pgtests/232_*.sql, which catches a bound that keeps the
           -- word and inverts the comparison.
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = '_invite_covers_person'
                          AND p.prosrc ~ 'person_ids_resolved_at' AND p.prosrc ~ 'first_seen')
          THEN 'ok' ELSE 'MISSING — re-apply 232' END),

    ('233  no money writer calls a shape that does not exist',
     CASE WHEN NOT EXISTS (
            -- The field-scoped call always passed a QUOTED field name in third
            -- position. Matched on that shape, not on a comma count: a regex
            -- cannot count arguments, because [^)]* crosses an opening
            -- parenthesis and reads the comma inside jsonb_build_object() as an
            -- extra one. 233's first draft did that and refused its own fix.
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind = 'f'
               AND (p.prosrc ~ $re$camp_family_save\s*\(\s*[a-z_]+\s*,\s*[a-z_]+\s*,\s*'$re$
                    OR p.prosrc ~ $re$camp_family_for_update\s*\(\s*[a-z_]+\s*,\s*[a-z_]+\s*,\s*'$re$))
          THEN 'ok' ELSE 'AUTOPAY IS STILL DOUBLE-CHARGING — re-apply 233' END),

    ('234  families and shop orders on ids',
     CASE WHEN to_regprocedure('public.camp_family_key_for_person(uuid,bigint,text)') IS NOT NULL
           AND to_regprocedure('public.verify_family_identity()') IS NOT NULL
           AND EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'camp_families'
                          AND column_name = 'person_ids')
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'settle_shop_order'
                          AND p.prosrc ~ 'camp_family_key_for_person')
          THEN 'ok' ELSE 'MISSING — re-apply 234' END),

    ('235  no function loses a camper on a rename',
     CASE WHEN to_regprocedure('public.receipt_recipient(uuid,text,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.receipt_recipient(uuid,text,text,text)') IS NULL
           AND to_regprocedure('public._latest_pickup_alert(uuid,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.mark_pickup_alert_league_checked(uuid,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.mark_pickup_alert_league_checked(uuid,text,text)') IS NULL
           AND to_regprocedure('public.add_pickup_alert_league_recipients(uuid,text,text[],text,text,bigint)') IS NOT NULL
           -- and the one that used to report success having changed nothing can
           -- now say otherwise
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public'
                          AND p.proname = 'mark_pickup_alert_league_checked'
                          AND p.prosrc ~ 'no_matching_alert')
          THEN 'ok' ELSE 'MISSING — re-apply 235' END),

    ('236  a person can attribute what no rule can',
     CASE WHEN to_regprocedure('public.camper_name_candidates(uuid)') IS NOT NULL
           AND to_regprocedure('public.attribute_camper_name(uuid,text,bigint,boolean)') IS NOT NULL
           AND to_regprocedure('public.verify_camper_attribution()') IS NOT NULL
           AND to_regprocedure('public.purge_unattributable_canteen_accounts(boolean)') IS NOT NULL
           -- the transposition it exists for, asked of the function itself
           AND public._name_letters('Sara Schepansky') = public._name_letters('Sara Schepasnky')
           AND public._name_letters('Sara Rosenfeld') <> public._name_letters('Chana Rosenfeld')
          THEN 'ok' ELSE 'MISSING — re-apply 236' END)
    ) AS t(item, result)

UNION ALL

  -- ─── 2. what the verifiers found ──────────────────────────────────────────
  -- Facts about your data. Several of these are SUPPOSED to be non-zero — read
  -- the notes in each migration's header. The ones worth acting on are called
  -- out in part 3.
  SELECT '2 what it found', v.item, v.result
    FROM (VALUES
    ('camp deletion',      public.verify_camp_deletion()::text),
    ('camper ids',         public.verify_camper_ids()::text),
    ('parent ownership',   public.verify_camper_ownership()::text),
    ('face consent',       public.verify_face_consent()::text),
    ('canteen identity',   public.verify_canteen_identity()::text),
    -- slots_a_later_arrival_could_claim must be 0. slots_awaiting_a_decision is
    -- a queue for the office, not a defect — work it with
    -- parent_invites_needing_attention() and restamp_parent_invite().
    ('parent invite identity', public.verify_parent_invite_identity()::text),
    -- still_matching_camper_names_by_hand must be []. 234 takes the last one.
    ('family identity',     public.verify_family_identity()::text),
    -- unresolved_accounts_with_a_plausible_match is the decision list; the rest
    -- of rows_the_roster_cannot_resolve is campers who left.
    ('camper attribution',  public.verify_camper_attribution()::text),
    -- Empty is the answer you want for both of these. Anything in the second is
    -- a function PostgREST cannot resolve, which fails every call from an edge
    -- function.
    ('still matching camper names by hand',
     COALESCE((SELECT jsonb_agg(DISTINCT p.proname)
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prokind = 'f'
                  AND p.prosrc ~ 'camper_names \?'), '[]'::jsonb)::text),
    ('ambiguous money RPCs',
     COALESCE((SELECT jsonb_object_agg(x.proname, x.arities)
                 FROM (SELECT p.proname,
                              jsonb_agg(DISTINCT p.pronargs ORDER BY p.pronargs) AS arities
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind = 'f'
                          AND (p.proname LIKE '%canteen%' OR p.proname LIKE '%shop_order%')
                        GROUP BY p.proname
                       HAVING count(DISTINCT p.pronargs) > 1
                          AND bool_or(p.pronargdefaults > 0)) x),
              '{}'::jsonb)::text)
    ) AS v(item, result)

UNION ALL

  -- ─── 3. the two repairs, still un-run ─────────────────────────────────────
  -- Both are DRY RUNS. Each returns the line to run when you have read it.
  -- Nothing here deletes anything.
  SELECT '3 what to do next', r.item, r.result
    FROM (VALUES
    ('orphaned camp data',   public.purge_orphaned_camp_data()::text),
    ('withdrawn face data',  public.purge_revoked_face_data()::text)
    ) AS r(item, result)

ORDER BY part, item;
