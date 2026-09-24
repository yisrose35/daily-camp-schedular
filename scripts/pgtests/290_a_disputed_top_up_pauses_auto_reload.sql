-- Behaviour test for migration 290 (TED-205): a canteen top-up disputed with
-- the bank switches that child's auto-reload off until the parent switches it
-- back on.
--   1. Avi's $20 auto-reload top-up is disputed: wallet $0 (287), auto-reload
--      off with the note Link shows, one notice; the same event again: nothing.
--   2. The nightly run writes back the copy it read before the dispute
--      (enabled): auto-reload stays off.
--   3. The parent switches it back on in Link: on, and the note is gone.
--   4. A child whose auto-reload was already off: nothing; service role only;
--      the checking script's 290 row says ok.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2900000-0000-0000-0000-0000000000a1', 'o@290.test'), ('f2900000-0000-0000-0000-0000000000e1', 'p@290.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2900000-0000-0000-0000-000000000901', 'f2900000-0000-0000-0000-0000000000a1', 'Reload Camp');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES ('f2900000-0000-0000-0000-000000000901', 'f2900000-0000-0000-0000-0000000000e1',
        'Avi parent', 'p@290.test', jsonb_build_array('Avi'), 'active');

CREATE TEMP TABLE stale_ar (old_ar jsonb);

DO $$
DECLARE c uuid := 'f2900000-0000-0000-0000-000000000901'; r jsonb; ar jsonb; n int;
BEGIN
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Avi', p_amount => 20, p_payment_intent_id => 'pi_avi');
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Bo', p_amount => 20, p_payment_intent_id => 'pi_bo');
    PERFORM public.canteen_account_save(c, 'Avi', (SELECT payload FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi')
        || '{"autoReload":{"enabled":true,"cardOnFile":true,"stripeCustomerId":"cus_avi","thresholdEnabled":true,"thresholdAmount":5,"thresholdReloadAmount":20}}'::jsonb);
    INSERT INTO stale_ar SELECT payload -> 'autoReload' FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';

    -- 1. disputed
    r := public.record_canteen_stripe_reversal(c, 'pi_avi', 'dp_avi', 20, 'dispute', NULL);
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'reversal: %', r; END IF;
    r := public.pause_canteen_autoreload_for_dispute(c, 'pi_avi', 'dp_avi');
    IF (r->>'changed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'pause: %', r; END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (ar->>'enabled')::boolean OR ar->>'disputeId' IS DISTINCT FROM 'dp_avi' OR ar->>'disabledReason' NOT LIKE '%disputed%' THEN
        RAISE EXCEPTION 'TED-205: a disputed top-up left auto-reload on: %', ar;
    END IF;
    r := public.pause_canteen_autoreload_for_dispute(c, 'pi_avi', 'dp_avi');
    IF (r->>'changed')::boolean THEN RAISE EXCEPTION 'paused twice: %', r; END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'canteen_autoreload_off';
    IF n <> 1 THEN RAISE EXCEPTION 'notices: %', n; END IF;

    -- 2. the nightly run writes back the copy it read before the dispute
    r := public.update_canteen_autoreload_state(c, 'Avi', (SELECT old_ar FROM stale_ar) || '{"lastChargedDate":"2026-09-24"}'::jsonb);
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (ar->>'enabled')::boolean OR NOT ar ? 'disputePausedAt' OR ar->>'lastChargedDate' IS DISTINCT FROM '2026-09-24' THEN
        RAISE EXCEPTION 'TED-205: the nightly run switched a dispute pause back on: %', ar;
    END IF;

    -- 4. already off: nothing; a top-up never credited: nothing
    r := public.pause_canteen_autoreload_for_dispute(c, 'pi_bo', 'dp_bo');
    IF (r->>'changed')::boolean OR r->>'reason' IS DISTINCT FROM 'auto_reload_off' THEN RAISE EXCEPTION 'off already: %', r; END IF;
    r := public.pause_canteen_autoreload_for_dispute(c, 'pi_none', 'dp_x');
    IF r->>'error' IS DISTINCT FROM 'deposit_not_found' THEN RAISE EXCEPTION 'unknown top-up: %', r; END IF;
    IF has_function_privilege('authenticated', 'public.pause_canteen_autoreload_for_dispute(uuid,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can switch a child''s auto-reload off';
    END IF;
END $$;

-- 3. the parent switches it back on in Link
DO $$
DECLARE c uuid := 'f2900000-0000-0000-0000-000000000901'; r jsonb; ar jsonb;
BEGIN
    PERFORM set_config('test.uid', 'f2900000-0000-0000-0000-0000000000e1', false);
    r := public.set_canteen_auto_reload(c, 'Avi', jsonb_build_object('enabled', true, 'thresholdEnabled', true, 'thresholdAmount', 5, 'thresholdReloadAmount', 20));
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'parent save: %', r; END IF;
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF NOT (ar->>'enabled')::boolean OR ar ? 'disputePausedAt' OR ar ? 'disabledReason' THEN
        RAISE EXCEPTION 'the parent could not switch it back on: %', ar;
    END IF;
    -- and now the nightly run's own write keeps it on
    r := public.update_canteen_autoreload_state(c, 'Avi', ar || '{"lastChargedDate":"2026-09-30"}'::jsonb);
    SELECT payload -> 'autoReload' INTO ar FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF NOT (ar->>'enabled')::boolean THEN RAISE EXCEPTION 'switched back off after the parent turned it on: %', ar; END IF;
    RAISE NOTICE 'ok  290: a disputed top-up pauses auto-reload until the parent switches it back on';
END $$;
RESET test.uid;

-- 5. TED-211/210: a Cardknox/Banquest top-up, found by its transaction number,
--    comes off the wallet; the child's family is found; a win puts it back and
--    a late message after the win pauses nothing (auto-reload or family).
DO $$
DECLARE c uuid := 'f2900000-0000-0000-0000-000000000901'; r jsonb; bal numeric; f jsonb;
BEGIN
    r := public.credit_canteen_balance_from_processor(c, 'Eli', 20.00, 'cardknox', 'tx_eli', 'parent');
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'processor credit: %', r; END IF;
    PERFORM public.camp_family_save(c, 'elifam', '{"name":"Eli Fam","camperIds":["Eli"]}'::jsonb);
    r := public.record_canteen_stripe_reversal(c, 'tx_eli', 'cb_eli', 999999, 'dispute', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Eli';
    IF (r->>'success')::boolean IS NOT TRUE OR bal <> 0 THEN RAISE EXCEPTION 'TED-211: a Cardknox top-up dispute left the wallet: % / %', r, bal; END IF;
    r := public.canteen_dispute_family(c, 'tx_eli');
    IF r->>'familyKey' IS DISTINCT FROM 'elifam' THEN RAISE EXCEPTION 'TED-210: the child''s family was not found: %', r; END IF;
    r := public.hold_autopay_for_dispute(c, 'elifam', 'cb_eli', true, 'canteen top-up');
    f := public.camp_family(c, 'elifam');
    IF NOT COALESCE((f->'disputeHold'->'disputeIds') ? 'cb_eli', false) THEN RAISE EXCEPTION 'TED-210: the family was not paused: %', f; END IF;
    -- won
    r := public.record_canteen_stripe_reversal(c, 'tx_eli', 'cb_eli', 20, 'dispute_won', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Eli';
    IF bal <> 20 THEN RAISE EXCEPTION 'won: wallet %', bal; END IF;
    r := public.hold_autopay_for_dispute(c, 'elifam', 'cb_eli', false);
    -- a late message after the win
    r := public.hold_autopay_for_dispute(c, 'elifam', 'cb_eli', true, NULL);
    IF (r->>'alreadyWon')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TED-210: a late message after a canteen win re-paused the family: %', r; END IF;
    r := public.pause_canteen_autoreload_for_dispute(c, 'tx_eli', 'cb_eli');
    IF (r->>'alreadyWon')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'a late message after a win paused auto-reload: %', r; END IF;
    IF NOT has_function_privilege('service_role', 'public.camp_family_key_for_person(uuid,bigint,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'TED-213: the nightly run cannot ask a child''s family by number';
    END IF;
    IF has_function_privilege('authenticated', 'public.canteen_dispute_family(uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can look up a family by a payment';
    END IF;
END $$;

-- 6. TED-211/214: the disputed charge is an AUTO-RELOAD one (kind 'autoreload'
--    on the BYOP path), not a hand-typed top-up. This is the case the mocked
--    edge test could not reach: the real lookup must find it by its number.
DO $$
DECLARE c uuid := 'f2900000-0000-0000-0000-000000000901'; r jsonb; bal numeric; k text;
BEGIN
    r := public.credit_canteen_balance_from_processor(c, 'Rex', 20.00, 'cardknox', 'tx_rex', 'autoreload');
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'auto-reload credit: %', r; END IF;
    SELECT payload ->> 'kind' INTO k FROM canteen_transactions WHERE camp_id = c AND payload ->> 'byopTransactionId' = 'tx_rex';
    IF k IS DISTINCT FROM 'autoreload' THEN RAISE EXCEPTION 'expected an autoreload row, got kind=%', k; END IF;
    PERFORM public.camp_family_save(c, 'rexfam', '{"name":"Rex Fam","camperIds":["Rex"]}'::jsonb);
    -- the lookup must find the auto-reload row by its number, and name the family
    r := public.canteen_dispute_family(c, 'tx_rex');
    IF r->>'familyKey' IS DISTINCT FROM 'rexfam' THEN
        RAISE EXCEPTION 'TED-211: a disputed AUTO-RELOAD charge was not found (kind autoreload): %', r;
    END IF;
    -- the money comes off the wallet
    r := public.record_canteen_stripe_reversal(c, 'tx_rex', 'cb_rex', 999999, 'dispute', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Rex';
    IF (r->>'success')::boolean IS NOT TRUE OR bal <> 0 THEN
        RAISE EXCEPTION 'TED-211: a disputed auto-reload charge stayed on the wallet: % / %', r, bal;
    END IF;
    -- that child's auto-reload switches off, and the family is named for pausing
    PERFORM public.canteen_account_save(c, 'Rex', (SELECT payload FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Rex')
        || '{"autoReload":{"enabled":true,"cardOnFile":true,"byopCustomerRef":"tok_rex","thresholdEnabled":true,"thresholdAmount":5,"thresholdReloadAmount":20}}'::jsonb);
    r := public.pause_canteen_autoreload_for_dispute(c, 'tx_rex', 'cb_rex');
    IF (r->>'changed')::boolean IS NOT TRUE OR r->>'familyKey' IS DISTINCT FROM 'rexfam' THEN
        RAISE EXCEPTION 'TED-211: a disputed auto-reload charge did not pause the child/family: %', r;
    END IF;
    RAISE NOTICE 'ok  290: a disputed Cardknox/Banquest AUTO-RELOAD charge is found, reversed and paused';
END $$;

\i migrations/290_a_disputed_top_up_pauses_auto_reload.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v290 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v290 WHERE item LIKE '290%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 290 row says: %', r; END IF;
END $$;
ROLLBACK;

-- TED-214 (Q10): each piece the checking script's 290 row checks
BEGIN;
DO $x$ BEGIN EXECUTE replace(pg_get_functiondef('public.set_canteen_auto_reload(uuid,text,jsonb,bigint)'::regprocedure),
    $a$(((v_ar - 'disabledReason') - 'disabledAt') - 'disputePausedAt') - 'disputeId'$a$, $b$(v_ar - 'disabledReason') - 'disabledAt'$b$); END $x$;
CREATE TEMP TABLE v290a AS :verify_q
DO $$ DECLARE r text; BEGIN SELECT result INTO r FROM v290a WHERE item LIKE '290%';
    IF r NOT LIKE 'apply 290 again%' THEN RAISE EXCEPTION 'TED-214: the checking script missed a parent save that keeps the pause: %', r; END IF; END $$;
ROLLBACK;
BEGIN;
DROP FUNCTION public.canteen_dispute_family(uuid, text);
CREATE TEMP TABLE v290b AS :verify_q
DO $$ DECLARE r text; BEGIN SELECT result INTO r FROM v290b WHERE item LIKE '290%';
    IF r NOT LIKE 'apply 290 again%' THEN RAISE EXCEPTION 'the checking script missed an earlier 290: %', r; END IF; END $$;
ROLLBACK;
