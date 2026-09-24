-- Behaviour test for migration 287 (TED-181): a canteen top-up refunded in the
-- Stripe dashboard, or disputed, comes off the child's wallet once; the camp is
-- told.
--   1. Avi's $20 top-up refunded in Stripe: wallet $0, one 'refund' line naming
--      the top-up and the refund, one notice; the same event again: nothing.
--   2. Bina's $20 top-up disputed after she spent $15: wallet -$15, the notice
--      says the family owes it; the camp wins: $20 back on (wallet $5).
--   3. Campistry's own refund (already on the wallet by its id): nothing more.
--   4. A top-up with a Campistry refund still waiting: nothing taken, the camp
--      is told to check.
--   5. Never more than the top-up had left; service role only; the checking
--      script's 287 row says ok.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2870000-0000-0000-0000-0000000000a1', 'o@287.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2870000-0000-0000-0000-000000000001', 'f2870000-0000-0000-0000-0000000000a1', 'Top-up Camp');

DO $$
DECLARE c uuid := 'f2870000-0000-0000-0000-000000000001'; r jsonb; bal numeric; n int;
BEGIN
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Avi', p_amount => 20, p_payment_intent_id => 'pi_a');
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Bina', p_amount => 20, p_payment_intent_id => 'pi_b');
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Chaim', p_amount => 30, p_payment_intent_id => 'pi_c');

    -- 1. refunded in the dashboard, twice
    r := public.record_canteen_stripe_reversal(c, 'pi_a', 're_dash', 20, 'refund', NULL);
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'amount')::numeric <> 20 THEN RAISE EXCEPTION 'refund: %', r; END IF;
    r := public.record_canteen_stripe_reversal(c, 'pi_a', 're_dash', 20, 'refund', NULL);
    IF (r->>'alreadyRecorded')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'twice: %', r; END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF bal <> 0 THEN RAISE EXCEPTION 'TED-181: Avi can still spend the refunded top-up: %', bal; END IF;
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND payload->>'kind' = 'refund'
       AND payload->>'stripePaymentIntentId' = 'pi_a' AND payload->>'stripeRefundId' = 're_dash';
    IF n <> 1 THEN RAISE EXCEPTION 'the refund line: %', n; END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'canteen_reversed';
    IF n <> 1 THEN RAISE EXCEPTION 'the camp was not told (or told twice): %', n; END IF;
    IF NOT public.is_money_notice('canteen_reversed') OR NOT public.is_money_notice('refund_failed') THEN RAISE EXCEPTION 'money notice list'; END IF;

    -- 2. disputed after spending $15; then won
    PERFORM public.canteen_account_save(c, 'Bina', (SELECT payload FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Bina') || '{"balance":5}'::jsonb);
    r := public.record_canteen_stripe_reversal(c, 'pi_b', 'dp_1', 20, 'dispute', 'Disputed — fraudulent');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Bina';
    IF bal <> -15 OR (r->>'overdrawn')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'dispute: % / %', bal, r; END IF;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE camp_id = c AND source_id = 'xref:dp_1' AND body LIKE '%the family owes the canteen%') THEN
        RAISE EXCEPTION 'the notice does not say Bina had spent it';
    END IF;
    r := public.record_canteen_stripe_reversal(c, 'pi_b', 'dp_1', 20, 'dispute_won', NULL);
    r := public.record_canteen_stripe_reversal(c, 'pi_b', 'dp_1', 20, 'dispute_won', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Bina';
    IF bal <> 5 THEN RAISE EXCEPTION 'a won dispute should put the $20 back once: %', bal; END IF;

    -- 3. Campistry's own refund of Chaim's top-up
    PERFORM public.reserve_canteen_refund(c, 'Chaim', 'scanteen:pi_c:1000:3000', 10, 'stripe', 'pi_c', 'k_c');
    PERFORM public.settle_canteen_refund_hold(c, 'scanteen:pi_c:1000:3000', 're_own');
    r := public.record_canteen_stripe_reversal(c, 'pi_c', 're_own', 10, 'refund', NULL);
    IF (r->>'own')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'own refund taken twice: %', r; END IF;

    -- 4. a Campistry refund still waiting
    PERFORM public.reserve_canteen_refund(c, 'Chaim', 'scanteen:pi_c:500:3000', 5, 'stripe', 'pi_c', 'k_c2');
    r := public.record_canteen_stripe_reversal(c, 'pi_c', 're_mystery', 5, 'refund', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Chaim';
    IF (r->>'held')::boolean IS NOT TRUE OR bal <> 15 THEN RAISE EXCEPTION 'while a refund waits: % / %', r, bal; END IF;
    PERFORM public.release_canteen_refund_hold(c, 'scanteen:pi_c:500:3000', interval '0 seconds');

    -- 5. never more than the top-up had left: $30, $10 refunded by Campistry → at most $20
    r := public.record_canteen_stripe_reversal(c, 'pi_c', 're_big', 30, 'refund', NULL);
    IF (r->>'amount')::numeric <> 20 THEN RAISE EXCEPTION 'more than the top-up had left: %', r; END IF;
    -- TED-191: repeated partial refunds, each once; never past what is left
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Dov', p_amount => 30, p_payment_intent_id => 'pi_d');
    r := public.record_canteen_stripe_reversal(c, 'pi_d', 're_p1', 10, 'refund', NULL);
    r := public.record_canteen_stripe_reversal(c, 'pi_d', 're_p1', 10, 'refund', NULL);
    r := public.record_canteen_stripe_reversal(c, 'pi_d', 're_p2', 10, 'refund', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Dov';
    IF bal <> 10 THEN RAISE EXCEPTION 'TED-191: two $10 refunds (one sent twice) should leave $10, not %', bal; END IF;
    r := public.record_canteen_stripe_reversal(c, 'pi_d', 're_p3', 25, 'refund', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Dov';
    IF (r->>'amount')::numeric <> 10 OR bal <> 0 THEN RAISE EXCEPTION 'TED-191: a $25 refund of the last $10 took % (balance %)', r->>'amount', bal; END IF;
    r := public.record_canteen_stripe_reversal(c, 'pi_d', 're_p4', 5, 'refund', NULL);
    IF r->>'nothing' IS DISTINCT FROM 'already_refunded' THEN RAISE EXCEPTION 'TED-191: past a fully refunded top-up: %', r; END IF;
    -- the same dispute told twice (created, then funds_withdrawn): once
    PERFORM public.credit_canteen_balance_from_stripe(p_camp_id => c, p_camper_name => 'Eli', p_amount => 20, p_payment_intent_id => 'pi_e');
    r := public.record_canteen_stripe_reversal(c, 'pi_e', 'dp_e', 20, 'dispute', NULL);
    r := public.record_canteen_stripe_reversal(c, 'pi_e', 'dp_e', 20, 'dispute', NULL);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Eli';
    IF bal <> 0 OR (r->>'alreadyRecorded')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'TED-191: a dispute taken twice: % / %', bal, r; END IF;

    r := public.record_canteen_stripe_reversal(c, 'pi_zzz', 're_x', 5, 'refund', NULL);
    IF r->>'error' IS DISTINCT FROM 'deposit_not_found' THEN RAISE EXCEPTION 'not a top-up: %', r; END IF;
    IF has_function_privilege('authenticated', 'public.record_canteen_stripe_reversal(uuid,text,text,numeric,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can take money off a wallet';
    END IF;
    RAISE NOTICE 'ok  287: dashboard refunds and disputes of top-ups come off the wallet once; won comes back; own refunds untouched';
END $$;

\i migrations/287_a_canteen_top_up_refunded_outside_campistry.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v287 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v287 WHERE item LIKE '287%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 287 row says: %', r; END IF;
END $$;
ROLLBACK;
