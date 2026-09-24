-- Behaviour test for migration 280 (TED-142, TED-145, TED-143): the season
-- close-out takes a child's canteen money off in full.
--   1. $50 with a $10 floor and the till's $20-a-day cash limit: all $50 comes
--      off, one 'closeout' line, and the child's auto-reload is switched off
--      with a reason the parent's Link page shows.
--   2. Never more than the balance, and said in words.
--   3. Only someone who can edit Billing at this camp.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES
  ('f2800000-0000-0000-0000-0000000000a1', 'o@280.test'),
  ('f2800000-0000-0000-0000-0000000000b1', 'x@280.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2800000-0000-0000-0000-000000000001', 'f2800000-0000-0000-0000-0000000000a1', 'Close Camp');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t280.uid', true), '')::uuid $f$;
SELECT set_config('t280.uid', 'f2800000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2800000-0000-0000-0000-0000000000a1"}', false);

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2800000-0000-0000-0000-000000000001', 'campistrySnacks',
  '{"settings":{"cashDailyMax":20,"cashReasonRequired":true}}'::jsonb);

DO $$
DECLARE c uuid := 'f2800000-0000-0000-0000-000000000001'; r jsonb; bal numeric; n int; ar jsonb;
BEGIN
    PERFORM public.canteen_account_save(c, 'Avi', jsonb_build_object('balance', 50.00, 'balanceFloor', 10,
        'autoReload', jsonb_build_object('enabled', true, 'cardOnFile', true, 'stripeCustomerId', 'cus_P',
                                         'thresholdEnabled', true, 'thresholdAmount', 5, 'thresholdReloadAmount', 20)));
    -- the till's cash-out would refuse this (the floor, and $20 a day)
    r := public.canteen_office_cash_out(c, 'Avi', 50, 'x', 'office', NULL, NULL);
    IF (r->>'success')::boolean THEN RAISE EXCEPTION 'setup: the till took $50 past its own limits: %', r; END IF;

    -- 2. never more than the balance
    r := public.canteen_season_closeout(c, NULL, 'Avi', 60, 'Season close-out: cash');
    IF r->>'error' IS DISTINCT FROM 'over_balance' OR r->>'message' NOT LIKE 'Only $50.00 is on the canteen account now%' THEN
        RAISE EXCEPTION 'more than the balance: %', r;
    END IF;

    -- 1. the whole $50
    r := public.canteen_season_closeout(c, NULL, 'Avi', 50, 'Season close-out: cash');
    SELECT balance, payload->'autoReload' INTO bal, ar FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (r->>'success')::boolean IS NOT TRUE OR bal <> 0 THEN
        RAISE EXCEPTION 'TED-142/145: the close-out did not take the whole $50: % balance %', r, bal;
    END IF;
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND payload->>'kind' = 'closeout' AND amount = 50 AND tx_type = 'debit';
    IF n <> 1 THEN RAISE EXCEPTION 'the close-out line: %', n; END IF;
    IF (ar->>'enabled')::boolean OR ar->>'disabledReason' NOT LIKE '%closed out the canteen balance%' OR ar->>'stripeCustomerId' <> 'cus_P' THEN
        RAISE EXCEPTION 'TED-143: auto-reload after the close-out: %', ar;
    END IF;

    -- 3. only Billing's editors
    PERFORM set_config('t280.uid', 'f2800000-0000-0000-0000-0000000000b1', false);
    r := public.canteen_season_closeout(c, NULL, 'Avi', 1, 'x');
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'a stranger closed out a wallet: %', r; END IF;
    PERFORM set_config('t280.uid', 'f2800000-0000-0000-0000-0000000000a1', false);
    IF has_function_privilege('anon', 'public.canteen_season_closeout(uuid,bigint,text,numeric,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anyone can close out a wallet';
    END IF;
    RAISE NOTICE 'ok  280: whole wallet past floor and till limit / never over the balance / auto-reload off / Billing editors only';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v280 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v280 WHERE item LIKE '280%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 280 row says: %', r; END IF;
END $$;
ROLLBACK;
