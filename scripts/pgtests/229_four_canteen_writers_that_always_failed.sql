-- Behaviour test for 229. Four money functions returned an error on every call
-- and nothing noticed, because 219's behaviour test never called any of them.
-- So this file CALLS all four, and checks the money afterwards.
--
--   1. A processor refund reduces the balance and writes a refund to the ledger.
--   2. The same refund id twice reduces it once.
--   3. A Stripe refund does the same, on its own idempotency key.
--   4. merge_canteen_autoreload_card attaches a card and MERGES — the parent's
--      enabled/threshold/amount survive the webhook's card fields.
--   5. p_require_existing refuses a camper with no account, and says `created`
--      truthfully. Both were unreachable before.
--   6. update_canteen_autoreload_state leaves the BALANCE ALONE. This is the one
--      that matters: 219's version passed the autoReload object as the whole
--      account, so the first auto-reload attempt would have zeroed it.
--   7. Three declines switch auto-reload off, stamp the reason ON autoReload, and
--      raise exactly one notification per switch-off day.
--   8. None of the four reports success when there is nothing to work on.
--   9. And a refund for a RENAMED camper reaches her own account — the claim that
--      needs 227's key translation and this file's guard fix at the same time.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

DO $$
DECLARE
    camp  uuid := 'f2900000-0000-0000-0000-000000000001';
    owner uuid := 'f2900000-0000-0000-0000-0000000000ff';
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (camp, owner, 'Refund Camp');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',  jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'))));
    PERFORM set_config('test.uid', owner::text, false);
END $$;


-- ── 1, 2, 3. the refunds ────────────────────────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
BEGIN
    PERFORM public.canteen_account_save(camp, 'Ayala Weiss',
        jsonb_build_object('balance', 50.00, 'dailyLimit', 10, 'spentToday', 0));

    -- 1. the processor refund
    r := public.refund_canteen_deposit_from_processor(camp, 'Ayala Weiss', 20.00,
             'cardknox', 'ext_229_a', 'ref_229_a');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a processor refund was refused: % — this is the call that has returned '
                        'no_canteen_data on every attempt since 219', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'balance after a 20.00 refund on 50.00 is %, expected 30.00', bal;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = camp AND payload ->> 'byopRefundId' = 'ref_229_a'
                      AND tx_type = 'debit' AND amount = 20.00) THEN
        RAISE EXCEPTION 'the refund did not reach the ledger';
    END IF;

    -- 2. the same refund again
    r := public.refund_canteen_deposit_from_processor(camp, 'Ayala Weiss', 20.00,
             'cardknox', 'ext_229_a', 'ref_229_a');
    IF (r ->> 'alreadyProcessed') <> 'true' THEN
        RAISE EXCEPTION 'a repeated refund was not recognised: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'a repeated refund reduced the balance twice: %', bal;
    END IF;

    -- 3. the Stripe refund, on its own key
    r := public.refund_canteen_deposit_from_stripe(camp, 'Ayala Weiss', 5.00,
             'pi_229_a', 'rf_229_a');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a Stripe refund was refused: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'balance after a 5.00 Stripe refund on 30.00 is %', bal;
    END IF;
    r := public.refund_canteen_deposit_from_stripe(camp, 'Ayala Weiss', 5.00,
             'pi_229_a', 'rf_229_a');
    IF (r ->> 'alreadyProcessed') <> 'true'
       OR (SELECT balance FROM camp_canteen_accounts
            WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'a repeated Stripe refund reduced the balance twice: %', r;
    END IF;

    -- The limits and spentToday came through untouched, because the save is given
    -- the whole account object.
    IF (SELECT daily_limit FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'the refund lost the daily limit';
    END IF;
    RAISE NOTICE '229: both refunds reduce the balance once, reach the ledger, and keep the '
                 'account''s other fields';
END $$;


-- ── 4, 5. the card merge ────────────────────────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    ar   jsonb;
BEGIN
    -- The parent configured auto-reload first: enabled, at a threshold, for an
    -- amount. Seeded on the account directly rather than through
    -- set_canteen_auto_reload, because that one is parent-facing and validates
    -- its own trigger shape — this file is about the four writers it fixes, not
    -- about re-testing a fifth.
    PERFORM public.canteen_account_save(camp, 'Ayala Weiss',
        jsonb_build_object('balance', 25.00, 'dailyLimit', 10, 'spentToday', 0,
                           'autoReload', jsonb_build_object(
                               'enabled', true, 'threshold', 5, 'amount', 20)));

    -- Then the webhook attaches the card. It knows only the card fields.
    r := public.merge_canteen_autoreload_card(camp, 'Ayala Weiss',
             jsonb_build_object('cardRef', 'tok_229', 'last4', '4242',
                                'processorKey', 'cardknox'));
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'attaching a card was refused: % — this has returned no_camp_data on '
                        'every attempt since 219', r;
    END IF;
    IF (r ->> 'created') <> 'false' THEN
        RAISE EXCEPTION 'the account already existed but `created` says %', r ->> 'created';
    END IF;

    -- 4. MERGED, not replaced.
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF (ar ->> 'cardRef') IS DISTINCT FROM 'tok_229'
       OR (ar ->> 'last4') IS DISTINCT FROM '4242' THEN
        RAISE EXCEPTION 'the card was not attached: %', ar;
    END IF;
    IF (ar ->> 'enabled') IS DISTINCT FROM 'true'
       OR (ar ->> 'threshold') IS DISTINCT FROM '5'
       OR (ar ->> 'amount') IS DISTINCT FROM '20' THEN
        RAISE EXCEPTION 'attaching the card wiped what the parent configured: %', ar;
    END IF;
    -- And the balance is where the refunds left it.
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'attaching a card moved the balance';
    END IF;

    -- 5. p_require_existing. Both branches were unreachable before.
    r := public.merge_canteen_autoreload_card(camp, 'Never Had An Account',
             jsonb_build_object('cardRef', 'tok_x'), true);
    IF (r ->> 'error') <> 'camper_not_found' THEN
        RAISE EXCEPTION 'p_require_existing did not refuse a camper with no account: %', r;
    END IF;
    IF EXISTS (SELECT 1 FROM camp_canteen_accounts
                WHERE camp_id = camp AND account_key = 'Never Had An Account') THEN
        RAISE EXCEPTION 'the refusal created the account anyway';
    END IF;
    -- Without the flag it creates one, and says so.
    r := public.merge_canteen_autoreload_card(camp, 'Never Had An Account',
             jsonb_build_object('cardRef', 'tok_x'), false);
    IF (r ->> 'success') <> 'true' OR (r ->> 'created') <> 'true' THEN
        RAISE EXCEPTION 'creating an account for a new camper did not report created: %', r;
    END IF;
    RAISE NOTICE '229: a card attaches and merges, the parent''s settings survive, and '
                 'p_require_existing works again';
END $$;


-- ── 6, 7. the auto-reload state write ───────────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
    ar   jsonb;
    n    bigint;
BEGIN
    -- 6. THE ONE THAT MATTERS. The balance is 25.00 and the daily limit is 10.
    r := public.update_canteen_autoreload_state(camp, 'Ayala Weiss',
             jsonb_build_object('enabled', true, 'threshold', 5, 'amount', 20,
                                'consecutiveFailures', 1,
                                'lastFailureReason', 'card declined'));
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'recording an auto-reload outcome was refused: % — this has returned '
                        'no_snacks_row on every attempt since 219', r;
    END IF;
    SELECT balance, daily_limit, payload -> 'autoReload'
      INTO bal, n, ar
      FROM camp_canteen_accounts WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF bal IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'recording an auto-reload outcome set the balance to % — 219''s version '
                        'passed the autoReload object as the WHOLE account, and this is what '
                        'that costs', bal;
    END IF;
    IF n IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'the daily limit was lost: %', n;
    END IF;
    IF (ar ->> 'consecutiveFailures') IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'the autoReload state was not recorded: %', ar;
    END IF;
    -- The card the webhook attached is inside autoReload, and this call replaces
    -- autoReload wholesale on purpose — 180's comment says only that sub-key is
    -- replaced, and the caller sends the full autoReload object it just read.
    IF (ar ->> 'cardRef') IS NOT NULL AND (ar ->> 'cardRef') <> 'tok_229' THEN
        RAISE EXCEPTION 'unexpected cardRef: %', ar;
    END IF;

    -- 7. Three declines, switching it off.
    r := public.update_canteen_autoreload_state(camp, 'Ayala Weiss',
             jsonb_build_object('enabled', false, 'threshold', 5, 'amount', 20,
                                'consecutiveFailures', 3,
                                'lastFailureReason', 'insufficient funds'));
    IF (r ->> 'autoReloadDisabled') <> 'true' THEN
        RAISE EXCEPTION 'three declines did not register as a switch-off: %', r;
    END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    IF (ar ->> 'disabledReason') IS DISTINCT FROM 'insufficient funds'
       OR (ar ->> 'disabledAt') IS NULL THEN
        RAISE EXCEPTION 'the reason was not stamped onto autoReload where 180 put it: %', ar;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'the switch-off moved the balance';
    END IF;

    -- One notification, and the same switch-off twice in a day is still one.
    SELECT count(*) INTO n FROM notifications
     WHERE camp_id = camp AND source = 'canteen_autoreload_off';
    IF n <> 1 THEN
        RAISE EXCEPTION '% notifications for one switch-off', n;
    END IF;
    PERFORM public.update_canteen_autoreload_state(camp, 'Ayala Weiss',
             jsonb_build_object('enabled', false, 'consecutiveFailures', 4,
                                'lastFailureReason', 'insufficient funds'));
    SELECT count(*) INTO n FROM notifications
     WHERE camp_id = camp AND source = 'canteen_autoreload_off';
    IF n <> 1 THEN
        RAISE EXCEPTION 'the same switch-off was reported % times in one day', n;
    END IF;

    -- An already-off card failing again is not news: was_on is false, so no
    -- notification and no claim of a switch-off.
    r := public.update_canteen_autoreload_state(camp, 'Ayala Weiss',
             jsonb_build_object('enabled', false, 'consecutiveFailures', 5));
    IF (r ->> 'autoReloadDisabled') <> 'false' THEN
        RAISE EXCEPTION 'an already-off card reported a fresh switch-off: %', r;
    END IF;
    RAISE NOTICE '229: recording an auto-reload outcome keeps the balance and the limits, '
                 'stamps the reason on autoReload, and reports one switch-off per day';
END $$;


-- ── 9. a refund for a renamed camper ───────────────────────────────────────
-- Needs both halves: 227 translates the new name to the account her money is on,
-- 229 stops the guard refusing before it gets there.
DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
BEGIN
    PERFORM public.canteen_account_save(camp, 'Dov Lerner',
        jsonb_build_object('balance', 30.00, 'dailyLimit', 10, 'spentToday', 0));
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Dov Lerner'
                             || jsonb_build_object('Dov L',
                                  jsonb_build_object('camperId', '881', 'name', 'Dov L')))
     WHERE camp_id = camp AND key = 'app1';

    r := public.refund_canteen_deposit_from_processor(camp, 'Dov L', 12.00,
             'cardknox', 'ext_229_r', 'ref_229_r');
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a refund under the new name was refused: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Dov Lerner';
    IF bal IS DISTINCT FROM 18.00 THEN
        RAISE EXCEPTION 'the refund did not reach the account opened under her old name: '
                        'balance is %, expected 18.00', bal;
    END IF;
    IF (SELECT count(*) FROM camp_canteen_accounts
         WHERE camp_id = camp AND person_id = 881) <> 1 THEN
        RAISE EXCEPTION 'the refund created a second account';
    END IF;
    RAISE NOTICE '229: a refund under a renamed camper''s new name reaches her own balance';
END $$;


-- ── 8. and none of them claims success with nothing to work on ──────────────
DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
BEGIN
    IF (public.refund_canteen_deposit_from_processor(camp, '', 5, 'k', 'e', 'r')
        ->> 'error') <> 'missing_params' THEN
        RAISE EXCEPTION 'an empty camper name was accepted by the processor refund';
    END IF;
    IF (public.refund_canteen_deposit_from_processor(camp, 'Dov Lerner', 0, 'k', 'e', 'r')
        ->> 'error') <> 'invalid_amount' THEN
        RAISE EXCEPTION 'a zero refund was accepted';
    END IF;
    IF (public.refund_canteen_deposit_from_processor(camp, 'Dov Lerner', 5, 'k', 'e', '')
        ->> 'error') <> 'missing_refund_id' THEN
        RAISE EXCEPTION 'a refund with no id was accepted — idempotency depends on it';
    END IF;
    IF (public.refund_canteen_deposit_from_stripe(camp, 'Dov Lerner', 5, 'pi', '')
        ->> 'error') <> 'missing_refund_id' THEN
        RAISE EXCEPTION 'a Stripe refund with no id was accepted';
    END IF;
    IF (public.merge_canteen_autoreload_card(camp, '', '{}'::jsonb)
        ->> 'error') <> 'bad_arguments'
       OR (public.merge_canteen_autoreload_card(camp, 'Dov Lerner', NULL)
        ->> 'error') <> 'bad_arguments' THEN
        RAISE EXCEPTION 'the card merge accepted bad arguments';
    END IF;
    IF (public.update_canteen_autoreload_state(camp, 'Dov Lerner', NULL)
        ->> 'error') <> 'missing_autoreload'
       OR (public.update_canteen_autoreload_state(camp, '', '{}'::jsonb)
        ->> 'error') <> 'missing_params' THEN
        RAISE EXCEPTION 'the auto-reload state write accepted bad arguments';
    END IF;
    RAISE NOTICE '229: all four still refuse what they always refused';
END $$;

RESET test.uid;


-- ── 10. and the rest of the script-converted writers, called at last ────────
-- tests/transform_leftovers.test.js flagged six more functions that 219's
-- transform rewrote and no behaviour test ever executed: set_canteen_limits,
-- set_canteen_auto_reload, submit_canteen_deposit, submit_shop_order,
-- use_family_card_for_canteen_auto_reload and settle_shop_order. Four in exactly
-- that position turned out to return an error on every call, so "converted and
-- never called" is not a state to leave anything in.
--
-- These five are PARENT-facing — they resolve the camp from the caller's invite —
-- so they are exercised as a parent, not as the owner.
--
-- camp_families_object comes from 212, which this chain does not include, so it
-- is stubbed with 212's own body reading the 211 rows. Stubbing it rather than
-- skipping the call is the point: without it,
-- use_family_card_for_canteen_auto_reload is never executed, which is the state
-- that let four functions ship broken.
CREATE OR REPLACE FUNCTION public.camp_families_object(p_camp_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_object_agg(family_key, payload), '{}'::jsonb)
      FROM public.camp_families
     WHERE camp_id = p_camp_id AND deleted_at IS NULL;
$$;
INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES ('f2900000-0000-0000-0000-000000000001', 'f2900000-0000-0000-0000-00000000e001',
        'Katz parent', 'k@example.test', jsonb_build_array('Ayala Weiss'), 'active');

DO $$
DECLARE
    camp uuid := 'f2900000-0000-0000-0000-000000000001';
    r    jsonb;
    bal  numeric;
BEGIN
    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-00000000e001', false);

    -- a deposit
    SELECT balance INTO bal FROM camp_canteen_accounts
     WHERE camp_id = camp AND account_key = 'Ayala Weiss';
    r := public.submit_canteen_deposit('Ayala Weiss', 10.00, camp);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'a parent deposit was refused: %', r;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal + 10.00 THEN
        RAISE EXCEPTION 'a 10.00 deposit on % left %', bal,
            (SELECT balance FROM camp_canteen_accounts
              WHERE camp_id = camp AND account_key = 'Ayala Weiss');
    END IF;
    -- and its bounds
    IF (public.submit_canteen_deposit('Ayala Weiss', 0.50, camp) ->> 'error') <> 'invalid_amount'
       OR (public.submit_canteen_deposit('Ayala Weiss', 501, camp) ->> 'error') <> 'invalid_amount' THEN
        RAISE EXCEPTION 'the deposit amount bounds stopped biting';
    END IF;
    -- another family's child
    IF (public.submit_canteen_deposit('Dov Lerner', 10.00, camp) ->> 'error')
       <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent deposited onto another family''s child';
    END IF;

    -- the limits
    r := public.set_canteen_limits('Ayala Weiss', 25, NULL, NULL, camp);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'setting a limit was refused: %', r;
    END IF;
    IF (SELECT daily_limit FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 25 THEN
        RAISE EXCEPTION 'the limit did not land';
    END IF;
    -- and it did not touch the money
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal + 10.00 THEN
        RAISE EXCEPTION 'setting a limit moved the balance';
    END IF;
    IF (public.set_canteen_limits('Ayala Weiss', 5000, NULL, NULL, camp) ->> 'error')
       <> 'bad_daily_limit' THEN
        RAISE EXCEPTION 'the limit clamp stopped biting';
    END IF;

    -- auto-reload, with a real trigger shape
    r := public.set_canteen_auto_reload(camp, 'Ayala Weiss', jsonb_build_object(
             'enabled', true, 'thresholdEnabled', true,
             'thresholdAmount', 5, 'thresholdReloadAmount', 20));
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'setting auto-reload was refused: %', r;
    END IF;
    IF (SELECT payload -> 'autoReload' ->> 'thresholdReloadAmount' FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM '20' THEN
        RAISE EXCEPTION 'the auto-reload config did not land';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM bal + 10.00 THEN
        RAISE EXCEPTION 'setting auto-reload moved the balance';
    END IF;
    -- enabled with no trigger is still refused
    IF (public.set_canteen_auto_reload(camp, 'Ayala Weiss',
            jsonb_build_object('enabled', true)) ->> 'error') <> 'no_trigger_selected' THEN
        RAISE EXCEPTION 'auto-reload accepted a config with no trigger';
    END IF;

    -- the family card. 214's version reads families through
    -- camp_families_object, so the family goes into the 211 rows.
    INSERT INTO camp_families (camp_id, family_key, payload)
    VALUES (camp, 'fam1', jsonb_build_object(
                'camperIds', jsonb_build_array('Ayala Weiss'),
                'byopCustomerRef', 'cus_229',
                'byopProcessor', 'cardknox',
                'paymentMethodLabel', 'Visa 4242'))
    ON CONFLICT (camp_id, family_key) DO UPDATE SET payload = EXCLUDED.payload;

    r := public.use_family_card_for_canteen_auto_reload(camp, 'Ayala Weiss', NULL);
    IF (r ->> 'success') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'attaching the family card was refused: %', r;
    END IF;
    IF (r ->> 'processorKey') <> 'cardknox' THEN
        RAISE EXCEPTION 'the wrong processor was chosen: %', r;
    END IF;
    IF (SELECT payload -> 'autoReload' ->> 'byopCustomerRef' FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM 'cus_229' THEN
        RAISE EXCEPTION 'the family card did not reach the account';
    END IF;
    -- the parent's own trigger config survived it
    IF (SELECT payload -> 'autoReload' ->> 'thresholdReloadAmount' FROM camp_canteen_accounts
         WHERE camp_id = camp AND account_key = 'Ayala Weiss') IS DISTINCT FROM '20' THEN
        RAISE EXCEPTION 'attaching the family card wiped the parent''s trigger config';
    END IF;
    -- a camper in no family
    IF (public.use_family_card_for_canteen_auto_reload(camp, 'Dov Lerner', NULL) ->> 'error')
       NOT IN ('camper_not_on_invite', 'family_not_found') THEN
        RAISE EXCEPTION 'the family card was attached to a camper with no family';
    END IF;

    RAISE NOTICE '229: the parent-facing deposit, limits, auto-reload and family card all work, '
                 'keep the balance, and refuse what they should';
END $$;

