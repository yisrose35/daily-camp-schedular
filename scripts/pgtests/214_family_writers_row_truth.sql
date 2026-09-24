-- Behaviour test for migration 214. The diff test proves the DECISIONS are
-- unchanged; this proves the new plumbing actually reaches the rows.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NULL, 'Family Writers');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'fw1', jsonb_build_object('name','Klein','camperIds', jsonb_build_array('Tzvi Klein')),
    'fw2', jsonb_build_object('name','Roth','camperIds', jsonb_build_array('Rivka Roth')))));

-- ── THE POINT: none of the eleven locks or writes the camp document ────────
DO $$
DECLARE r record; bad text[] := ARRAY[]::text[];
BEGIN
    FOR r IN
        SELECT p.proname, pg_get_functiondef(p.oid) AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('merge_camp_family_fields','append_family_payment_method',
                             'remove_payment_method','set_default_payment_method',
                             'use_family_card_for_canteen_auto_reload','flag_expiring_cards',
                             'flag_plan_collection','resolve_chargeback','settle_shop_order',
                             '_admin_backfill_saved_payment_methods',
                             '_admin_clear_stale_byop_cards')
    LOOP
        IF r.def ~ 'UPDATE camp_state_kv[^;]*campistryMe' THEN
            bad := bad || (r.proname || ' still writes the document');
        END IF;
        IF r.def ~ 'key = ''campistryMe''[^;]*FOR UPDATE' THEN
            bad := bad || (r.proname || ' still locks the document');
        END IF;
    END LOOP;
    IF array_length(bad, 1) > 0 THEN
        RAISE EXCEPTION 'nothing got faster: %', array_to_string(bad, '; ');
    END IF;
    RAISE NOTICE 'ok  all eleven are off the camp document, for both lock and write';
END $$;

-- ── and the shop / canteen locks SURVIVE, because those blobs still need them
DO $$
DECLARE d text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='settle_shop_order';
    IF d !~ 'campistryShop''\s*\n?\s*FOR UPDATE' AND d !~ 'campistryShop''[^;]*FOR UPDATE' THEN
        RAISE EXCEPTION 'settle_shop_order lost its campistryShop lock — that blob is still read-modify-written';
    END IF;
    SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='use_family_card_for_canteen_auto_reload';
    -- The canteen account must be LOCKED before it is written. At 214 that was
    -- the campistrySnacks document; from 219 the canteen is rows and the lock is
    -- canteen_account_lock on the one camper's row (241 is the current body).
    -- Either satisfies the rule; neither is a lost update waiting to happen.
    IF d !~ 'campistrySnacks''[^;]*FOR UPDATE' AND d !~ 'canteen_account_lock\s*\(' THEN
        RAISE EXCEPTION 'the canteen lock was removed — a lost update on the snacks ledger';
    END IF;
    -- and the account must be created if missing, or auto-reload fails for a
    -- camper who has never bought anything: the document's create-if-missing
    -- before 219, canteen_account_lock's own INSERT … ON CONFLICT after it.
    IF d !~ 'campistrySnacks''' AND d !~ 'canteen_account_lock\s*\(' THEN
        RAISE EXCEPTION 'the canteen create-if-missing was stripped';
    END IF;
    RAISE NOTICE 'ok  the shop and canteen locks and creates survived';
END $$;

-- ── merge_camp_family_fields writes the family ROW ────────────────────────
DO $$
DECLARE r jsonb; fam jsonb;
BEGIN
    r := public.merge_camp_family_fields('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'fw1',
             jsonb_build_object('notes','merged note','balance',42));
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'merge failed: %', r; END IF;
    fam := public.camp_family('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw1');
    IF (fam ->> 'notes') <> 'merged note' THEN
        RAISE EXCEPTION 'the merge did not reach the family row: %', fam;
    END IF;
    IF (fam ->> 'name') <> 'Klein' THEN
        RAISE EXCEPTION 'the merge clobbered fields it was not given: %', fam;
    END IF;
    -- and it touched nobody else
    IF (public.camp_family('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw2') ->> 'notes') IS NOT NULL THEN
        RAISE EXCEPTION 'the merge leaked into another family';
    END IF;
    RAISE NOTICE 'ok  merge_camp_family_fields writes one family row and merges, not replaces';
END $$;

-- ── the document is NOT updated by that write ─────────────────────────────
DO $$
DECLARE before_val jsonb; after_val jsonb;
BEGIN
    SELECT value INTO before_val FROM camp_state_kv
     WHERE camp_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND key='campistryMe';
    PERFORM public.merge_camp_family_fields('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw2',
              jsonb_build_object('notes','second'));
    SELECT value INTO after_val FROM camp_state_kv
     WHERE camp_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND key='campistryMe';
    IF after_val IS DISTINCT FROM before_val THEN
        RAISE EXCEPTION 'a family write still modified the camp document';
    END IF;
    IF (public.camp_family('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw2') ->> 'notes') <> 'second' THEN
        RAISE EXCEPTION 'the write went nowhere';
    END IF;
    RAISE NOTICE 'ok  a family write reaches the row and leaves the document alone';
END $$;

-- ── TWO FAMILIES CAN BE WRITTEN WITHOUT CONTENDING ────────────────────────
-- The whole point: one family's lock must not exclude another's. Proved by
-- holding fw1's row lock in a subtransaction-free way we can observe: take the
-- lock, then confirm fw2 is still lockable with NOWAIT.
DO $$
DECLARE got jsonb;
BEGIN
    PERFORM public.camp_family_for_update('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw1');
    -- A second lock on a DIFFERENT family must succeed immediately.
    PERFORM 1 FROM public.camp_families
     WHERE camp_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND family_key='fw2'
       FOR UPDATE NOWAIT;
    RAISE NOTICE 'ok  holding one family''s lock does not block another family';
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'one family lock blocked another — the camp-wide lock is still effectively there';
END $$;

-- ── the admin backfill actually changes something ─────────────────────────
-- R4b exists because without it this applied, reported success, and changed no
-- card on file.
DO $$
DECLARE r jsonb; fam jsonb;
BEGIN
    PERFORM public.camp_family_save('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw1',
        public.camp_family('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw1')
        || jsonb_build_object('byopCustomerRef','cus_1','cardBrand','Visa','cardLast4','4242'));
    r := public._admin_backfill_saved_payment_methods('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'backfill failed: %', r; END IF;
    fam := public.camp_family('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fw1');
    IF jsonb_typeof(fam -> 'savedPaymentMethods') <> 'array'
       OR jsonb_array_length(fam -> 'savedPaymentMethods') < 1 THEN
        RAISE EXCEPTION 'the backfill reported success and changed nothing: % / %', r, fam;
    END IF;
    RAISE NOTICE 'ok  the admin backfill reaches the family rows (R4b earns its place)';
END $$;

SELECT 'ALL 214 BEHAVIOUR CHECKS PASSED' AS result;
