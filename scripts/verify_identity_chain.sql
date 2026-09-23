-- ============================================================================
-- Confirm migrations 222-259 are in and doing their job.
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
          THEN 'ok' ELSE 'MISSING — re-apply 236' END),

    ('237  a departed camper''s number is not reused',
     CASE WHEN to_regprocedure('public._move_person_references(uuid,bigint,bigint)') IS NOT NULL
           AND to_regprocedure('public.camper_returns_as(uuid,text,bigint,boolean)') IS NOT NULL
           AND to_regprocedure('public.verify_person_references()') IS NOT NULL
           -- The index must be PARTIAL, or a departed camper still blocks a new
           -- arrival and the roster save aborts.
           AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                        WHERE c.relname = 'uq_camp_people_source'
                          AND pg_get_expr(i.indpred, i.indrelid) ~ 'deleted_at IS NULL')
           -- and the lookup excludes the departed
           AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname IN ('_project_people', '_number_people')
                          AND p.prosrc ~ 'source_key = r\.k[^;]*deleted_at IS NULL'
                          AND p.prosrc ~ '_move_person_references')
          THEN 'ok' ELSE 'A REUSED NAME STILL STEALS AN IDENTITY — re-apply 237' END),

    ('238  the canteen ledger moves with the person',
     CASE WHEN to_regprocedure('public._person_reference_columns()') IS NOT NULL
           -- The ledger column, which no catalog rule can find: it is called
           -- camper_id and it is text, and only 227's INSERT proves it holds a
           -- person id.
           AND EXISTS (SELECT 1 FROM public._person_reference_columns()
                        WHERE table_name = 'canteen_transactions'
                          AND column_name = 'camper_id' AND is_text)
           -- and the discovered half did not get lost adding the named half
           AND (SELECT count(*) FROM public._person_reference_columns()
                 WHERE NOT is_text) >= 10
          THEN 'ok' ELSE 'A RENUMBER STILL LEAVES THE LEDGER BEHIND — re-apply 238' END)
    ) AS t(item, result)

UNION ALL

  -- ─── 1b. 239-248, read off the DEPLOYED function bodies ───────────────────
  -- A separate block, and the bodies are computed in a subquery rather than
  -- through 239's _prosrc_code helper, for one reason that cost a rewrite:
  -- POSTGRES RESOLVES FUNCTION NAMES WHEN IT PLANS THE STATEMENT, not when it
  -- reaches them. A reference to _prosrc_code anywhere in this script — even in a
  -- CASE branch that cannot be taken — makes the WHOLE script fail with "function
  -- does not exist" on a database that has not applied 239. Which is exactly the
  -- database this script exists to describe.
  --
  -- prosrc includes COMMENTS, so the bodies have their line comments stripped:
  -- 239's own header quotes the unsafe comparison it removes, and a plain text
  -- match would find the prose and report the defect as still present.
  SELECT '1 is it there', x.item, x.result
    FROM (SELECT (SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = 'settle_shop_order'
                   LIMIT 1) AS settle,
                 (SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = 'canteen_office_credit'
                   LIMIT 1) AS credit,
                 (SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public'
                     AND p.proname = 'use_family_card_for_canteen_auto_reload'
                   LIMIT 1) AS card,
                 (SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public'
                     AND p.proname = 'canteen_office_import_offline'
                   LIMIT 1) AS offl,
                 (SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = 'canteen_account_key_for'
                   LIMIT 1) AS keyfor,
                 (SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname = 'get_canteen_accounts'
                   LIMIT 1) AS ledger) b
    CROSS JOIN LATERAL (VALUES
    -- ⚠ THE ONE TO READ FIRST. Until 239, a signed-in user who belongs to no camp
    -- could call settle_shop_order with ANY camp's id and debit a camper's canteen
    -- balance. The gate compared the caller's camp with <>, and <> against the NULL
    -- that get_user_camp_id returns for such a caller is NULL, so the IF never
    -- fired. Reproduced against a real Postgres: $7.00 off a camper at a camp the
    -- caller had nothing to do with.
    ('239  a stranger cannot settle another camp''s order',
     CASE WHEN b.settle IS NOT NULL
           AND b.settle ~ 'IS DISTINCT FROM get_user_camp_id'
           AND b.settle ~ 'NOT camp_staff_member'
           AND b.settle !~ '<> get_user_camp_id'
          THEN 'ok' ELSE 'A STRANGER CAN STILL DEBIT A CAMPER — apply 239 NOW' END),

    -- The desk's own money. Its deposit, cash-out and limit writers wrote a
    -- document branch that is stripped before the upsert, so the office took cash
    -- in hand and the next hydration put the camper back to where they were.
    ('240  the canteen desk writes to the cloud',
     CASE WHEN to_regprocedure('public.canteen_office_credit(uuid,text,numeric,text,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.canteen_office_cash_out(uuid,text,numeric,text,text,text,bigint)') IS NOT NULL
           AND to_regprocedure('public.canteen_office_set_limit(uuid,text,numeric,bigint)') IS NOT NULL
           -- and the credit writer posts a LEDGER row, not just a balance: a
           -- balance with nothing behind it is erased by the next reconcile.
           AND b.credit ~ 'canteen_post'
          THEN 'ok' ELSE 'A DESK DEPOSIT STILL GOES NOWHERE — apply 240' END),

    -- A card attached for auto-reload has to be one the charger can find.
    -- canteen-auto-reload skips a camper unless autoReload carries byopCustomerRef
    -- or stripeCustomerId; 234 wrote a paymentMethodId instead, so the parent was
    -- told the card was on file and the nightly run passed the camper by.
    ('241  a family card the charger can find',
     CASE WHEN to_regprocedure('public.verify_family_card_autoreload(uuid)') IS NOT NULL
           AND b.card ~ 'byopCustomerRef'
           AND b.card ~ 'camp_family_key_for_person'
          THEN 'ok' ELSE 'AN ATTACHED FAMILY CARD STILL NEVER RELOADS — apply 241' END),

    -- Sales rung up on the offline register. The import wrote a document branch
    -- that is stripped on the way out, so every camper who bought something while
    -- the register was offline got it free at the next reload.
    ('242  offline-register sales reach the ledger',
     CASE WHEN b.offl IS NOT NULL
           AND b.offl ~ '''offline:'''
           AND b.offl ~ 'sig\s*=\s*v_sig'
           AND b.offl ~ 'camp_person_(label|name_for)'
          THEN 'ok' ELSE 'OFFLINE SALES STILL GO NOWHERE — apply 242' END),

    -- The nightly auto-reload found its campers in the document's accounts,
    -- which are stripped since 219, so it charged nobody. The SQL half; the
    -- four edge functions it names must also be redeployed.
    ('243  the nightly reload reads the rows (and redeploy 4 edge functions)',
     CASE WHEN to_regprocedure('public.canteen_autoreload_accounts(uuid)') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'canteen_camper_known')
          THEN 'ok' ELSE 'AUTO-RELOAD STILL CHARGES NOBODY — apply 243' END),

    -- A renamed child's account is keyed by the old spelling; a new child with
    -- that spelling used to be handed it.
    ('244  a new child does not inherit a renamed child''s account',
     CASE WHEN b.keyfor ~ '''\s*#'''
          THEN 'ok' ELSE 'A NEW CHILD CAN SPEND A RENAMED CHILD''S MONEY — apply 244' END),

    -- The ledger both the office and parents read came from the frozen document.
    ('245  the canteen ledger is read from its rows',
     CASE WHEN b.ledger ~ 'FROM canteen_transactions' AND b.ledger !~ '''campistrySnacks'''
          THEN 'ok' ELSE 'CANTEEN HISTORY IS FROZEN AT 219 — apply 245' END),

    -- A parent's balance counted payments from a branch gone since 158.
    ('246  a parent''s balance counts what they paid',
     CASE WHEN NOT EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND p.proname IN ('get_my_balance_derived', 'report_plan_undercollection')
                 AND regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
                     ~ '''finance''\s*->\s*''payments''')
          THEN 'ok' ELSE 'A PARENT CAN BE SHOWN MONEY THEY ALREADY PAID — apply 246' END),

    -- The register: accepted staff only, and the camper by id.
    ('247  the register charges a person, and only staff can',
     CASE WHEN to_regprocedure('public.submit_canteen_purchase(uuid,text,numeric,text,date,bigint)') IS NOT NULL
           AND to_regprocedure('public.submit_canteen_purchase(uuid,text,numeric,text,date)') IS NULL
          THEN 'ok' ELSE 'AN UNACCEPTED INVITATION CAN CHARGE A CAMPER — apply 247' END),

    -- Every function that names a camper also takes the camper's id.
    ('248  every camper function takes an id',
     CASE WHEN NOT EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND pg_get_function_identity_arguments(p.oid) ~ '\mp_camper(_name)?\M'
                 AND pg_get_function_identity_arguments(p.oid) !~ '(p_camper_id|p_person_id)'
                 AND p.proname !~ '__by_name$')
          THEN 'ok' ELSE 'SOME FUNCTIONS STILL TAKE ONLY A NAME — apply 248' END),

    -- The parent portal can learn its children's ids, to send them.
    ('249  a parent knows their children''s ids',
     CASE WHEN to_regprocedure('public.get_my_camper_ids(uuid)') IS NOT NULL
          THEN 'ok' ELSE 'THE PORTAL NAMES CHILDREN BY SPELLING — apply 249' END),

    -- The refund functions (service role) can read what they refund.
    ('250  canteen refunds can read what they refund',
     CASE WHEN to_regprocedure('public.canteen_refund_view(uuid)') IS NOT NULL
          THEN 'ok' ELSE 'EVERY CANTEEN REFUND FAILS — apply 250' END),

    -- A coded letter finds the camper in camp_people, not a roster that is not there.
    ('251  camper mail finds the camper by id',
     CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = '_camper_mail_by_camper_number'
                 AND p.prosrc ~ 'camp_people')
          THEN 'ok' ELSE 'A LETTER WITH THE RIGHT CODE NEVER REACHES THE CAMPER — apply 251' END),

    ('252  a tip cart remembers the camper',
     CASE WHEN to_regclass('public.link_tip_cart_items') IS NULL OR EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'link_tip_cart_items'
                 AND column_name = 'person_id')
          THEN 'ok' ELSE 'A CART TIP IS FILED BY NAME — apply 252' END),

    -- The server numbers every camper, before the save, and writes it back.
    ('253  one number, one camper',
     CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_zz_number_camp_campers'
                          AND tgrelid = 'public.camp_state_kv'::regclass)
           AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_project_camp_campers'
                              AND tgrelid = 'public.camp_state_kv'::regclass)
           AND to_regprocedure('public.camper_number_problems()') IS NOT NULL
          THEN 'ok' ELSE 'THE BROWSER STILL HANDS OUT CAMPER NUMBERS — apply 253' END),

    -- And today, in every camp: nobody shows a number that is not theirs.
    ('253  every camper shows their own, unique number',
     CASE WHEN to_regprocedure('public.camper_number_problems()') IS NULL THEN 'apply 253'
          ELSE COALESCE((SELECT 'PROBLEMS: ' || count(*) || ' — see SELECT * FROM public.camper_number_problems();'
                           FROM public.camper_number_problems() HAVING count(*) > 0), 'ok') END),

    ('254  erasing a camper frees their number',
     CASE WHEN to_regprocedure('public.erase_camper(uuid,bigint,boolean)') IS NOT NULL
           AND to_regprocedure('public.merge_campers(uuid,bigint,bigint)') IS NOT NULL
           AND to_regclass('public.camp_erased_files') IS NOT NULL
          THEN 'ok' ELSE 'A DELETED CAMPER''S DATA IS NEVER ERASED — apply 254' END),

    ('255  a parent''s family and bill are found by camper number',
     CASE WHEN to_regprocedure('public.verify_parent_matching_on_numbers()') IS NULL THEN 'apply 255'
          WHEN public.verify_parent_matching_on_numbers() -> 'still_matching_children_by_name' = '[]'::jsonb THEN 'ok'
          ELSE 'STILL BY NAME: ' || (public.verify_parent_matching_on_numbers() ->> 'still_matching_children_by_name') END),

    ('256  faces, photo tags and forms go by camper number',
     CASE WHEN to_regprocedure('public.verify_rows_matched_by_number()') IS NULL THEN 'apply 256'
          WHEN public.verify_rows_matched_by_number() -> 'still_matching_rows_by_name_or_number' = '[]'::jsonb THEN 'ok'
          ELSE 'STILL BY NAME: ' || (public.verify_rows_matched_by_number() ->> 'still_matching_rows_by_name_or_number') END),

    -- For every camper, enrolled or departed: does their number come back to them?
    ('257  every camper''s number reaches that camper',
     CASE WHEN to_regprocedure('public.verify_number_round_trip()') IS NULL THEN 'apply 257'
          WHEN public.verify_number_round_trip() -> 'numbers_that_miss_their_camper' = '[]'::jsonb
           AND public.verify_number_round_trip() -> 'enrolled_names_that_miss_their_camper' = '[]'::jsonb
           AND public.verify_number_round_trip() -> 'functions_that_do_not_pin' = '[]'::jsonb THEN 'ok'
          ELSE 'PROBLEMS: ' || (public.verify_number_round_trip() - 'campers_checked')::text END),

    -- A parent's health documents, photos and face card: by the row's camper
    -- number; one face row, and one reference photo per pose, per child.
    ('258  a parent''s documents, photos and faces go by camper number',
     CASE WHEN to_regprocedure('public.verify_parent_reads_by_number()') IS NULL THEN 'apply 258'
          WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public'
                          AND p.prosrc ~ '_parent_owns_camper\s*\(\s*[^,]+,\s*[a-z_]+\.camper_name'
                          AND p.prosrc !~ '_parent_owns_person\s*\(')
            THEN 'STILL BY NAME: ' || (SELECT string_agg(p.proname, ', ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public'
                          AND p.prosrc ~ '_parent_owns_camper\s*\(\s*[^,]+,\s*[a-z_]+\.camper_name'
                          AND p.prosrc !~ '_parent_owns_person\s*\(')
          WHEN to_regclass('public.link_camper_faces_one_per_person') IS NULL
            THEN 'face rows are still one per NAME — re-apply 258'
          WHEN to_regclass('public.idx_lcfd_parent_pose') IS NOT NULL
            THEN 'reference photos are still one per NAME — re-apply 258'
          ELSE 'ok' END),

    -- A roster key belongs to one child while anything about them exists,
    -- and a rename keeps the camper's number.
    ('259  a roster key belongs to one child; a rename keeps the number',
     CASE WHEN to_regprocedure('public.verify_roster_keys()') IS NULL THEN 'apply 259'
          WHEN public.verify_roster_keys() -> 'keys_shown_by_the_wrong_child' <> '[]'::jsonb
            THEN 'KEY ON THE WRONG CHILD: ' || (public.verify_roster_keys() ->> 'keys_shown_by_the_wrong_child')
          WHEN (public.verify_roster_keys() ->> 'unrecorded_keys')::int <> 0
            THEN (public.verify_roster_keys() ->> 'unrecorded_keys') || ' keys not recorded — re-apply 259'
          ELSE 'ok' END)
    ) AS x(item, result)

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
    -- keys_shared_before_259: where a departed child's old records may sit under
    -- a live child's key (from before 259). Worth a look; not an error.
    ('roster keys',        public.verify_roster_keys()::text),
    -- slots_a_later_arrival_could_claim must be 0. slots_awaiting_a_decision is
    -- a queue for the office, not a defect — work it with
    -- parent_invites_needing_attention() and restamp_parent_invite().
    ('parent invite identity', public.verify_parent_invite_identity()::text),
    -- still_matching_camper_names_by_hand must be []. 234 takes the last one.
    ('family identity',     public.verify_family_identity()::text),
    -- unresolved_accounts_with_a_plausible_match is the decision list; the rest
    -- of rows_the_roster_cannot_resolve is campers who left.
    ('camper attribution',  public.verify_camper_attribution()::text),
    -- rows_pointing_at_nobody must be 0. spellings_reused_after_a_departure is
    -- a fact about the camp, and before 237 each one was a single shared row.
    ('person references',   public.verify_person_references()::text),
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
    ('withdrawn face data',  public.purge_revoked_face_data()::text),
    -- Not a repair — a count. Every camper here has a parent who believes a card
    -- is attached for auto-reload and an account that will never reload, because
    -- 234 wrote a paymentMethodId the charger does not read. Re-attaching is one
    -- click per family; 241 makes the click work. Nothing is guessed at here
    -- because which autoReload blocks 234 wrote is not knowable after the fact.
    -- Every camper here has a parent who believes a card is attached for
    -- auto-reload and an account that will never reload: 234 wrote a
    -- paymentMethodId where canteen-auto-reload reads byopCustomerRef or
    -- stripeCustomerId. Re-attaching is one click per family and 241 makes the
    -- click work; nothing is guessed at, because which autoReload blocks 234 wrote
    -- is not knowable after the fact.
    --
    -- Counted inline rather than through 241's verifier, for the same
    -- resolved-at-plan-time reason as the block above.
    ('family cards that cannot reload',
     COALESCE((SELECT jsonb_object_agg(c.name, n.bad)
                 FROM camps c
                 CROSS JOIN LATERAL (
                     SELECT count(*) AS bad FROM camp_canteen_accounts a
                      WHERE a.camp_id = c.id AND a.deleted_at IS NULL
                        AND COALESCE((a.payload -> 'autoReload' ->> 'enabled')::boolean, false)
                        AND COALESCE(a.payload -> 'autoReload' ->> 'paymentMethodId', '') <> ''
                        AND COALESCE(a.payload -> 'autoReload' ->> 'byopCustomerRef', '') = ''
                        AND COALESCE(a.payload -> 'autoReload' ->> 'stripeCustomerId', '') = '') n
                WHERE n.bad > 0), '{}'::jsonb)::text)
    ) AS r(item, result)

ORDER BY part, item;
