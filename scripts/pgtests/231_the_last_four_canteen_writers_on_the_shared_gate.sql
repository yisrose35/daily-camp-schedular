-- Behaviour test for 231. Four parent money functions moved off their own copy
-- of the name-containment check, so there are two ways this ships broken: a
-- parent who can no longer do something they could, or a parent who can now do
-- something to a child who is not theirs.
--
--   1. All four work for a RENAMED camper, by the new name — which is the point.
--      Before this file each answered camper_not_on_invite for the rest of the
--      season.
--   2. All four work by camper id with no name at all.
--   3. An id with a MISMATCHED name beside it is labelled from the roster.
--   4. All four refuse another family's child, by name and by id.
--   5. The family lookup finds the family after a rename — camperIds holds names
--      and is not rewritten, so this needed more than a substitution.
--   6. Every amount, bound and clamp is unchanged: the $1-$500 deposit range, the
--      0-1000 limit clamps, the auto-reload validation ladder, the processor
--      choice and the field-clearing on a card switch.
--   7. Setting a limit or configuring auto-reload still does not move the money.
--   8. One overload each, the old signatures gone, and no function in the
--      database tests camper_names ? by hand any more.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;


-- ── 8. the shape ────────────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.proname IN ('submit_canteen_deposit', 'set_canteen_limits',
                             'set_canteen_auto_reload',
                             'use_family_card_for_canteen_auto_reload')
         GROUP BY p.proname
    LOOP
        IF r.c <> 1 THEN
            RAISE EXCEPTION 'public.% has % overloads', r.proname, r.c;
        END IF;
    END LOOP;
    IF to_regprocedure('public.submit_canteen_deposit(text,numeric,uuid)') IS NOT NULL
       OR to_regprocedure('public.set_canteen_limits(text,numeric,numeric,numeric,uuid)') IS NOT NULL
       OR to_regprocedure('public.set_canteen_auto_reload(uuid,text,jsonb)') IS NOT NULL
       OR to_regprocedure('public.use_family_card_for_canteen_auto_reload(uuid,text,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'an old signature survived, so PostgREST has two candidates';
    END IF;

    -- The whole file, asked of the catalog. Nothing anywhere may still be doing
    -- the containment test by hand.
    FOR r IN
        SELECT p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosrc ~ 'camper_names \?'
    LOOP
        RAISE EXCEPTION 'public.% still tests camper_names ? by hand', r.proname;
    END LOOP;
    RAISE NOTICE '231: one overload each, the old signatures are gone, and nothing tests '
                 'camper_names ? by hand any more';
END $$;


-- ── the camp, a renamed camper, a sibling, and another family ───────────────
DO $$
DECLARE
    camp  uuid := 'f3100000-0000-0000-0000-000000000001';
    owner uuid := 'f3100000-0000-0000-0000-0000000000ff';
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (camp, owner, 'Last Four Camp');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',  jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'))));
END $$;

-- The invite names her OLD spelling and is never rewritten. 223's trigger stamps
-- person_ids at this moment, which is what carries her through the rename.
INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES
    ('f3100000-0000-0000-0000-000000000001', 'f3100000-0000-0000-0000-00000000f001',
     'Weiss parent', 'w@example.test', jsonb_build_array('Ayala Weiss'), 'active'),
    ('f3100000-0000-0000-0000-000000000001', 'f3100000-0000-0000-0000-00000000f002',
     'Lerner parent', 'l@example.test', jsonb_build_array('Dov Lerner'), 'active');

-- Her family, with a vaulted card. camperIds holds her OLD key, as a real one
-- would after a rename.
--
-- camper_ids IS SET AS WELL AS the payload, and that is not belt and braces. Every
-- real writer keeps the two in step — camp_family_save sets both, and 211's
-- projection sets both from the document — and since migration 234 the readers
-- match on the COLUMN rather than on payload -> 'camperIds'. This fixture used to
-- insert the payload alone, so the column defaulted to '[]' and every one of 234's
-- three ways to recognise her found nothing. The test then reported
-- family_not_found for a divergence no code path can produce, which reads as a
-- regression in 234 and is not one.
INSERT INTO camp_families (camp_id, family_key, camper_ids, payload)
VALUES ('f3100000-0000-0000-0000-000000000001', 'weiss',
        jsonb_build_array('Ayala Weiss'),
        jsonb_build_object(
            'camperIds', jsonb_build_array('Ayala Weiss'),
            'byopCustomerRef', 'cus_231',
            'byopProcessor', 'cardknox',
            'paymentMethodType', 'card',
            'paymentMethodLabel', 'Visa 4242'))
ON CONFLICT (camp_id, family_key) DO UPDATE
    SET camper_ids = EXCLUDED.camper_ids, payload = EXCLUDED.payload;

-- She has a balance, and then the camp renames her.
DO $$
DECLARE camp uuid := 'f3100000-0000-0000-0000-000000000001';
BEGIN
    PERFORM public.canteen_account_save(camp, 'Ayala Weiss',
        jsonb_build_object('balance', 30.00, 'dailyLimit', 10, 'spentToday', 0));
    IF (SELECT person_ids FROM link_parent_invites
         WHERE user_id = 'f3100000-0000-0000-0000-00000000f001')
       IS DISTINCT FROM jsonb_build_array(880) THEN
        RAISE EXCEPTION 'the invite was not stamped with her id — nothing below would work';
    END IF;

    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Ayala Weiss'
                             || jsonb_build_object('Ayala Weiss-Katz',
                                  jsonb_build_object('camperId', '880',
                                                     'name', 'Ayala Weiss-Katz')))
     WHERE camp_id = camp AND key = 'app1';
    IF public.camp_person_by_name(camp, 'Ayala Weiss') IS NOT NULL THEN
        RAISE EXCEPTION 'the old spelling still resolves, so the rename case is not reproducible';
    END IF;
END $$;


-- ── 1, 2, 3, 4, 6, 7. the four, after the rename ────────────────────────────
DO $$
DECLARE
    camp uuid := 'f3100000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
    ar   jsonb;
BEGIN
    PERFORM set_config('test.uid', 'f3100000-0000-0000-0000-00000000f001', false);

    -- ── submit_canteen_deposit ──────────────────────────────────────────────
    -- 1. By her NEW name, which her invite has never heard of.
    r := public.submit_canteen_deposit('Ayala Weiss-Katz', 10.00, camp, NULL);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a renamed camper''s parent could not top her up: % — this is the '
                        'camper_not_on_invite that lasted the rest of the season', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 40.00 THEN
        RAISE EXCEPTION 'the deposit did not reach her own account: balance is %', bal;
    END IF;
    -- 2. And by id, with no name at all.
    r := public.submit_canteen_deposit(NULL, 5.00, camp, 880);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a deposit by camper id was refused: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 45.00 THEN
        RAISE EXCEPTION 'the id deposit did not land';
    END IF;
    -- 6. the $1-$500 range, unchanged
    IF (public.submit_canteen_deposit('Ayala Weiss-Katz', 0.50, camp, NULL) ->> 'error')
       <> 'invalid_amount'
       OR (public.submit_canteen_deposit('Ayala Weiss-Katz', 501, camp, NULL) ->> 'error')
       <> 'invalid_amount' THEN
        RAISE EXCEPTION 'the deposit amount range changed';
    END IF;
    -- 4. another family's child, by name and by id
    IF (public.submit_canteen_deposit('Dov Lerner', 10.00, camp, NULL) ->> 'error')
       <> 'camper_not_on_invite'
       OR (public.submit_canteen_deposit(NULL, 10.00, camp, 881) ->> 'error')
       <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent topped up another family''s child';
    END IF;

    -- ── set_canteen_limits ──────────────────────────────────────────────────
    r := public.set_canteen_limits('Ayala Weiss-Katz', 25, NULL, NULL, camp, NULL);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a renamed camper''s limit could not be set: %', r;
    END IF;
    IF (SELECT daily_limit FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 25 THEN
        RAISE EXCEPTION 'the limit landed on a different account';
    END IF;
    -- 7. and it did not move the money
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 45.00 THEN
        RAISE EXCEPTION 'setting a limit moved the balance';
    END IF;
    -- 6. the clamps, unchanged
    IF (public.set_canteen_limits('Ayala Weiss-Katz', 5000, NULL, NULL, camp, NULL) ->> 'error')
       <> 'bad_daily_limit'
       OR (public.set_canteen_limits('Ayala Weiss-Katz', NULL, -1, NULL, camp, NULL) ->> 'error')
       <> 'bad_credit_limit'
       OR (public.set_canteen_limits('Ayala Weiss-Katz', NULL, NULL, 5000, camp, NULL) ->> 'error')
       <> 'bad_balance_floor' THEN
        RAISE EXCEPTION 'the limit clamps changed';
    END IF;
    -- 2. by id
    IF (public.set_canteen_limits(NULL, 30, NULL, NULL, camp, 880) ->> 'success') <> 'true' THEN
        RAISE EXCEPTION 'setting a limit by camper id was refused';
    END IF;
    -- 4. another family's child
    IF (public.set_canteen_limits(NULL, 30, NULL, NULL, camp, 881) ->> 'error')
       <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent set another family''s child''s limit';
    END IF;

    -- ── set_canteen_auto_reload ─────────────────────────────────────────────
    r := public.set_canteen_auto_reload(camp, 'Ayala Weiss-Katz', jsonb_build_object(
             'enabled', true, 'thresholdEnabled', true,
             'thresholdAmount', 5, 'thresholdReloadAmount', 20), NULL);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a renamed camper''s auto-reload could not be set: %', r;
    END IF;
    IF (SELECT payload -> 'autoReload' ->> 'thresholdReloadAmount' FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM '20' THEN
        RAISE EXCEPTION 'the auto-reload config landed somewhere else';
    END IF;
    -- 7. still no movement
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 45.00 THEN
        RAISE EXCEPTION 'setting auto-reload moved the balance';
    END IF;
    -- 6. the validation ladder, unchanged
    IF (public.set_canteen_auto_reload(camp, 'Ayala Weiss-Katz',
            jsonb_build_object('enabled', true), NULL) ->> 'error') <> 'no_trigger_selected'
       OR (public.set_canteen_auto_reload(camp, 'Ayala Weiss-Katz',
            jsonb_build_object('enabled', true, 'thresholdEnabled', true,
                               'thresholdAmount', 5, 'thresholdReloadAmount', 9999),
            NULL) ->> 'error') <> 'bad_threshold_reload_amount'
       OR (public.set_canteen_auto_reload(camp, 'Ayala Weiss-Katz',
            jsonb_build_object('enabled', true, 'scheduleEnabled', true,
                               'scheduleFrequency', 'fortnightly'),
            NULL) ->> 'error') <> 'bad_schedule_frequency'
       OR (public.set_canteen_auto_reload(camp, 'Ayala Weiss-Katz',
            jsonb_build_object('enabled', true, 'thresholdEnabled', true,
                               'thresholdAmount', 5, 'thresholdReloadAmount', 20,
                               'startDate', 'not-a-date'),
            NULL) ->> 'error') <> 'bad_start_date' THEN
        RAISE EXCEPTION 'the auto-reload validation ladder changed';
    END IF;
    -- 4. another family's child
    IF (public.set_canteen_auto_reload(camp, NULL, jsonb_build_object(
            'enabled', true, 'thresholdEnabled', true,
            'thresholdAmount', 5, 'thresholdReloadAmount', 20), 881) ->> 'error')
       <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent configured another family''s child''s auto-reload';
    END IF;

    -- ── use_family_card_for_canteen_auto_reload ─────────────────────────────
    -- 5. The family's camperIds still holds her OLD key. Matching the current
    --    roster key alone would answer family_not_found for exactly the child
    --    this file is meant to unblock.
    r := public.use_family_card_for_canteen_auto_reload(camp, 'Ayala Weiss-Katz', NULL, NULL);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the family card could not be attached after a rename: % — camperIds '
                        'still holds her old key', r;
    END IF;
    IF (r ->> 'processorKey') <> 'cardknox' THEN
        RAISE EXCEPTION 'the wrong processor was chosen: %', r;
    END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF (ar ->> 'byopCustomerRef') IS DISTINCT FROM 'cus_231'
       OR (ar ->> 'cardOnFile') IS DISTINCT FROM 'true'
       OR (ar ->> 'paymentMethodLabel') IS DISTINCT FROM 'Visa 4242' THEN
        RAISE EXCEPTION 'the card did not reach the account: %', ar;
    END IF;
    -- 6. and it left the parent's own trigger config alone
    IF (ar ->> 'thresholdReloadAmount') IS DISTINCT FROM '20'
       OR (ar ->> 'enabled') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'attaching the card wiped the parent''s trigger config: %', ar;
    END IF;
    -- 6. a Stripe-only family clears the BYOP fields rather than keeping both
    -- Through camp_family_save, not a raw UPDATE of `payload`. The column
    -- camper_ids is what camp_family_key_for_person reads (migration 234), and
    -- every real writer keeps it in step with the document because that function
    -- sets both. Writing only the payload here left the column holding her OLD
    -- name, so the lookup missed and this test reported family_not_found for a
    -- divergence no code path can produce. The fixture was wrong, not 234.
    PERFORM public.camp_family_save(camp, 'weiss', jsonb_build_object(
               'camperIds', jsonb_build_array('Ayala Weiss'),
               'stripeCustomerId', 'cus_stripe_231',
               'stripePaymentMethodId', 'pm_231',
               'cardOnFile', true,
               'paymentMethodLabel', 'Mastercard 5555'));
    r := public.use_family_card_for_canteen_auto_reload(camp, NULL, NULL, 880);
    IF (r ->> 'processorKey') <> 'stripe' THEN
        RAISE EXCEPTION 'switching to a Stripe family did not switch the processor: %', r;
    END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF (ar ? 'byopCustomerRef') OR (ar ->> 'stripeCustomerId') IS DISTINCT FROM 'cus_stripe_231' THEN
        RAISE EXCEPTION 'a camper ended up with both a stale BYOP token and a new Stripe one: %', ar;
    END IF;

    -- 6b. AND BACK THE OTHER WAY. The check above only covered one direction, and a
    -- mutation that stopped the cardknox branch clearing the Stripe fields survived
    -- it — the camper would then hold a live BYOP token and a dead Stripe one, and
    -- canteen-auto-reload tries byopCustomerRef FIRST, so nobody would notice until
    -- the Stripe token was the one that mattered.
    PERFORM public.camp_family_save(camp, 'weiss', jsonb_build_object(
               'camperIds', jsonb_build_array('Ayala Weiss'),
               'byopCustomerRef', 'cus_back_231',
               'byopProcessor', 'cardknox',
               'paymentMethodType', 'card',
               'paymentMethodLabel', 'Visa 4242'));
    r := public.use_family_card_for_canteen_auto_reload(camp, NULL, NULL, 880);
    IF (r ->> 'processorKey') <> 'cardknox' THEN
        RAISE EXCEPTION 'switching back to a BYOP family did not switch the processor: %', r;
    END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF (ar ? 'stripeCustomerId') OR (ar ? 'stripePaymentMethodId')
       OR (ar ->> 'byopCustomerRef') IS DISTINCT FROM 'cus_back_231' THEN
        RAISE EXCEPTION 'the stale Stripe token was kept beside the new BYOP one: %', ar;
    END IF;
    -- 4. another family's child
    IF (public.use_family_card_for_canteen_auto_reload(camp, NULL, NULL, 881) ->> 'error')
       <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent attached a card to another family''s child';
    END IF;

    RAISE NOTICE '231: all four work for a renamed camper and by id, keep the money and the '
                 'bounds, and refuse another family''s child';
END $$;


-- ── 3. an id with a mismatched name is labelled from the roster ─────────────
DO $$
DECLARE
    camp uuid := 'f3100000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
BEGIN
    PERFORM set_config('test.uid', 'f3100000-0000-0000-0000-00000000f001', false);
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';

    -- Her id, the OTHER child's name. The id decides, so the money moves on her
    -- account and the ledger row is filed there.
    r := public.submit_canteen_deposit('Dov Lerner', 7.00, camp, 880);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the id path was refused because of the name beside it: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal + 7.00 THEN
        RAISE EXCEPTION 'the deposit did not land on the id''s own account';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Dov Lerner') IS NOT NULL THEN
        RAISE EXCEPTION 'the name beside the id opened an account for the wrong child';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = camp AND camper = 'Ayala Weiss'
                      AND camper_id = '880' AND amount = 7.00) THEN
        RAISE EXCEPTION 'the ledger row was not filed against her';
    END IF;
    RAISE NOTICE '231: an id with another child''s name beside it moves the id''s money and is '
                 'labelled from the roster';
END $$;

RESET test.uid;


-- ── 9. switching processor clears the stale canteen cards ───────────────────
-- _admin_clear_stale_byop_cards iterated campistrySnacks.accounts, which since
-- 219 nothing writes — so it cleared nothing, and a camp that switched processor
-- kept every camper's token for the processor it had left. Auto-reload then went
-- on trying to charge through a processor that was gone.
DO $$
DECLARE
    camp uuid := 'f3100000-0000-0000-0000-000000000001';
    r    jsonb;
    ar   jsonb;
    bal  numeric;
BEGIN
    PERFORM set_config('test.uid', 'f3100000-0000-0000-0000-00000000f001', false);

    -- Put a Cardknox token back on her account, and give the sibling a Stripe one
    -- so the sweep has to leave one alone.
    PERFORM public.canteen_account_save(camp, 'Ayala Weiss-Katz',
        public.canteen_account_lock(camp, 'Ayala Weiss-Katz')
            || jsonb_build_object('autoReload', jsonb_build_object(
                   'enabled', true, 'thresholdEnabled', true,
                   'thresholdAmount', 5, 'thresholdReloadAmount', 20,
                   'byopProcessor', 'cardknox', 'byopCustomerRef', 'cus_231',
                   'paymentMethodLabel', 'Visa 4242', 'cardOnFile', true)));
    PERFORM public.canteen_account_save(camp, 'Dov Lerner',
        jsonb_build_object('balance', 12.00, 'dailyLimit', 10, 'spentToday', 0,
                           'autoReload', jsonb_build_object(
                               'enabled', true, 'stripeCustomerId', 'cus_stripe',
                               'stripePaymentMethodId', 'pm_x', 'cardOnFile', true)));
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';

    -- The camp switches to Stripe. Her Cardknox token must go; the sibling's
    -- Stripe one must stay.
    r := public._admin_clear_stale_byop_cards(camp, 'stripe');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the processor sweep failed: %', r;
    END IF;
    IF (r ->> 'cleared')::int < 1 THEN
        RAISE EXCEPTION 'the sweep cleared nothing — it is still reading the document: %', r;
    END IF;

    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF (ar ? 'byopCustomerRef') OR (ar ? 'byopProcessor')
       OR (ar ->> 'cardOnFile') IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'a token for the processor the camp left is still on file: %', ar;
    END IF;
    -- The parent's own trigger config is not a card and must survive.
    IF (ar ->> 'thresholdReloadAmount') IS DISTINCT FROM '20' THEN
        RAISE EXCEPTION 'the sweep wiped the parent''s trigger config: %', ar;
    END IF;
    -- And it did not touch the money.
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal THEN
        RAISE EXCEPTION 'the sweep moved a balance';
    END IF;

    -- The sibling's Stripe card belongs to the processor now in use.
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Dov Lerner';
    IF (ar ->> 'stripeCustomerId') IS DISTINCT FROM 'cus_stripe'
       OR (ar ->> 'cardOnFile') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'the sweep cleared a card for the processor still in use: %', ar;
    END IF;

    -- Running it again clears nothing more.
    r := public._admin_clear_stale_byop_cards(camp, 'stripe');
    IF (r ->> 'cleared')::int <> 0 THEN
        RAISE EXCEPTION 'the sweep is not idempotent — it cleared % on a second pass',
                        r ->> 'cleared';
    END IF;
    RAISE NOTICE '231: switching processor clears the stale canteen tokens on the ROWS, leaves '
                 'the current processor''s cards and the trigger config, and is idempotent';
END $$;

RESET test.uid;
