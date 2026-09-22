-- ============================================================================
-- Confirm migrations 222-231 are in and doing their job.
--
-- Paste the whole thing into the Supabase SQL Editor. It is READ ONLY — every
-- statement is a SELECT, nothing is created, changed or deleted, and the one
-- purge function it calls is called in its DRY RUN form.
--
-- It answers in three blocks:
--
--   1. IS IT THERE — one row per migration, saying whether the functions it
--      created exist and whether the overloads it dropped are gone. Anything
--      other than "ok" here means that file did not apply.
--   2. WHAT IT FOUND — the verifiers' own numbers, as jsonb. These are facts
--      about your data, not pass/fail: some are meant to be non-zero.
--   3. WHAT TO DO NEXT — the two destructive repairs, still un-run, with the
--      exact line to run when you have read the dry run above it.
--
-- Safe to run as often as you like.
-- ============================================================================

-- ─── 1. is it there ─────────────────────────────────────────────────────────
-- to_regprocedure returns NULL for a signature that does not exist instead of
-- erroring, so a missing function reads as a row saying so rather than killing
-- the whole script.
SELECT * FROM (
    VALUES
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
          THEN 'ok' ELSE 'STILL AMBIGUOUS — see the list in block 2' END),

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

    ('231  no writer asks the camper question itself',
     CASE WHEN to_regprocedure('public.submit_canteen_deposit(text,numeric,uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_canteen_deposit(text,numeric,uuid)') IS NULL
           AND to_regprocedure('public.set_canteen_limits(text,numeric,numeric,numeric,uuid,bigint)') IS NOT NULL
           AND to_regprocedure('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)') IS NOT NULL
           AND to_regprocedure('public.use_family_card_for_canteen_auto_reload(uuid,text,text,bigint)') IS NOT NULL
           -- nothing anywhere still tests camper_names ? by hand
           AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public' AND p.prokind = 'f'
                              AND p.prosrc ~ 'camper_names \?')
           -- and the two halves that were left on the campistrySnacks document
           AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = 'public'
                              AND p.proname IN ('use_family_card_for_canteen_auto_reload',
                                                '_admin_clear_stale_byop_cards')
                              AND p.prosrc ~ 'campistrySnacks')
          THEN 'ok' ELSE 'MISSING — re-apply 231' END),

    ('230  a shop order records what it took',
     CASE WHEN to_regprocedure('public.submit_shop_order(text,jsonb,text,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_shop_order(text,jsonb,text,text,text)') IS NULL
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'submit_shop_order'
                          AND p.prosrc ~ 'settlement')
          THEN 'ok' ELSE 'MISSING or the stale overload survived — re-apply 230' END)
) AS t(migration, applied)
ORDER BY migration;


-- ─── 2. what the verifiers found ────────────────────────────────────────────
-- Facts about your data. Several of these are SUPPOSED to be non-zero — read
-- the notes in each migration's header. The ones worth acting on are called out
-- in block 3.
SELECT 'camp deletion'     AS area, public.verify_camp_deletion()     AS found
UNION ALL
SELECT 'camper ids',              public.verify_camper_ids()
UNION ALL
SELECT 'parent ownership',        public.verify_camper_ownership()
UNION ALL
SELECT 'face consent',            public.verify_face_consent()
UNION ALL
SELECT 'canteen identity',        public.verify_canteen_identity()
UNION ALL
-- Empty is the answer you want. Anything here is a function PostgREST cannot
-- resolve, which fails every call from an edge function.
SELECT 'still matching camper names by hand',
       COALESCE((SELECT jsonb_agg(DISTINCT p.proname)
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.prokind = 'f'
                    AND p.prosrc ~ 'camper_names \?'), '[]'::jsonb)
UNION ALL
SELECT 'ambiguous money RPCs',
       COALESCE((SELECT jsonb_object_agg(x.proname, x.arities)
                   FROM (SELECT p.proname,
                                jsonb_agg(DISTINCT p.pronargs ORDER BY p.pronargs) AS arities
                           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.prokind = 'f'
                            AND (p.proname LIKE '%canteen%' OR p.proname LIKE '%shop_order%')
                          GROUP BY p.proname
                         HAVING count(DISTINCT p.pronargs) > 1
                            AND bool_or(p.pronargdefaults > 0)) x),
                '{}'::jsonb);


-- ─── 3. the two repairs, still un-run ───────────────────────────────────────
-- Both are DRY RUNS here. Each returns the line to run when you have read it.
-- Nothing below deletes anything.
SELECT 'orphaned camp data'  AS repair, public.purge_orphaned_camp_data() AS dry_run
UNION ALL
SELECT 'withdrawn face data',          public.purge_revoked_face_data();
