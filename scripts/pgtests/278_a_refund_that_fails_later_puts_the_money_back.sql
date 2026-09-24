-- Behaviour test for migration 278 (TED-126): a Stripe refund that fails after
-- Stripe accepted it puts the money back where it was booked, once.
--   1. A canteen refund: the child's wallet gets the money back, with a
--      "refund failed" line the refund screens can see; a Billing notice.
--   2. The same failure again (Stripe re-sends events) changes nothing.
--   3. A family refund: the ledger gets the money back as a payment, the
--      payments list the matching row; the ledger sync does not post it twice.
--   4. A refund not on these books is left alone, but the office is told once
--      (TED-131); a browser can call none of it.
--   5. The put-back reopens the refund's reservation, so the next Refund All
--      (the same reservation name) refunds it again (TED-129).
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2780000-0000-0000-0000-0000000000a1', 'o@278.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2780000-0000-0000-0000-000000000001', 'f2780000-0000-0000-0000-0000000000a1', 'Refund Camp');

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2780000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'gold', jsonb_build_object('name', 'Gold', 'camperIds', jsonb_build_array('Dov Gold'),
       'entries', jsonb_build_array(
          jsonb_build_object('id', 'le_t', 'kind', 'charge', 'amount', 500, 'reason', 'tuition'),
          jsonb_build_object('id', 'le_pay_pi_g', 'kind', 'payment', 'amount', 500, 'reason', 'card', 'source', jsonb_build_object('paymentId', 'pi_g')),
          jsonb_build_object('id', 'le_pay_re_f1', 'kind', 'refund', 'amount', 200, 'reason', 'refund', 'source', jsonb_build_object('paymentId', 're_f1')))))));

DO $$
DECLARE
    c   uuid := 'f2780000-0000-0000-0000-000000000001';
    r   jsonb;
    bal numeric;
    n   int;
    fam jsonb;
BEGIN
    -- a $20 canteen refund, made the way the refund functions make it
    PERFORM public.canteen_account_save(c, 'Avi', jsonb_build_object('balance', 20.00, 'balanceFloor', 0));
    PERFORM public.reserve_canteen_refund(c, 'Avi', 'scanteen:pi_1:2000:2000', 20, 'stripe', 'pi_1', 'canteen_refund_pi_1_2000_2000');
    PERFORM public.settle_canteen_refund_hold(c, 'scanteen:pi_1:2000:2000', 're_c1');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF bal <> 0 THEN RAISE EXCEPTION 'setup: the refund did not come off (balance %)', bal; END IF;

    -- 1. it failed: the money goes back, once
    r := public.reverse_failed_stripe_refund(c, 're_c1', 'expired or canceled card');
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'canteen')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'canteen reversal: %', r; END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF bal <> 20 THEN RAISE EXCEPTION 'TED-126: the failed refund''s $20 is not back on the wallet (balance %)', bal; END IF;
    SELECT count(*) INTO n FROM canteen_transactions
     WHERE camp_id = c AND payload->>'kind' = 'refund_failed' AND payload->>'failedRefundId' = 're_c1'
       AND payload->>'stripePaymentIntentId' = 'pi_1' AND tx_type = 'credit' AND amount = 20;
    IF n <> 1 THEN RAISE EXCEPTION 'the "refund failed" line: % rows', n; END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'refund_failed' AND source_id = 're_c1';
    IF n <> 1 OR (r->>'firstNotice')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'no Billing notice for the failed canteen refund: %', r; END IF;
    -- 5. the reservation is open again: the same Refund All name takes the $20 afresh
    SELECT count(*) INTO n FROM canteen_refund_holds WHERE camp_id = c AND hold_key = 'scanteen:pi_1:2000:2000' AND state = 'released';
    IF n <> 1 THEN RAISE EXCEPTION 'TED-129: the put-back refund''s reservation still says it was sent'; END IF;
    -- the refund screens see it (so the top-up is refundable again)
    r := public.canteen_refund_view(c);
    SELECT count(*) INTO n FROM jsonb_array_elements(r->'transactions') t WHERE t->>'kind' = 'refund_failed' AND (t->>'amount')::numeric = 20;
    IF n <> 1 THEN RAISE EXCEPTION 'canteen_refund_view does not show the put-back line: %', r->'transactions'; END IF;

    -- 2. the same failure again
    r := public.reverse_failed_stripe_refund(c, 're_c1', 'expired or canceled card');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (r->>'alreadyRecorded')::boolean IS NOT TRUE OR bal <> 20 THEN
        RAISE EXCEPTION 'a re-sent failure put the money back twice: % balance %', r, bal;
    END IF;
    r := public.reserve_canteen_refund(c, 'Avi', 'scanteen:pi_1:2000:2000', 20, 'stripe', 'pi_1', 'canteen_refund_pi_1_2000_2000');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    IF (r->>'success')::boolean IS NOT TRUE OR COALESCE((r->>'existing')::boolean, false) OR bal <> 0 THEN
        RAISE EXCEPTION 'TED-129: Refund All''s next try did not take the put-back $20: % balance %', r, bal;
    END IF;
    PERFORM public.settle_canteen_refund_hold(c, 'scanteen:pi_1:2000:2000', 're_c2');
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND account_key = 'Avi';
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND payload->>'stripeRefundId' = 're_c2';
    IF bal <> 0 OR n <> 1 THEN RAISE EXCEPTION 'the second refund: balance % lines %', bal, n; END IF;

    -- 3. a family refund of $200 failed: the family is owed nothing and holds the $200 again
    fam := public.camp_family(c, 'gold');
    IF public.family_ledger_balance(fam) <> 200 THEN RAISE EXCEPTION 'setup: gold owes % (want 200)', public.family_ledger_balance(fam); END IF;
    r := public.reverse_failed_stripe_refund(c, 're_f1', NULL);
    fam := public.camp_family(c, 'gold');
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'family')::boolean IS NOT TRUE OR public.family_ledger_balance(fam) <> 0 THEN
        RAISE EXCEPTION 'TED-126: the failed family refund was not put back: % owes %', r, public.family_ledger_balance(fam);
    END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(fam->'entries') e
     WHERE e->>'kind' = 'payment' AND e->>'reason' = 'refund_failed' AND (e->>'amount')::numeric = 200
       AND e #>> '{source,reverses}' = 'le_pay_re_f1';
    IF n <> 1 THEN RAISE EXCEPTION 'the put-back entry: %', fam->'entries'; END IF;
    SELECT count(*) INTO n FROM camp_payments WHERE camp_id = c AND payment_id = 'refail_re_f1' AND amount = 200 AND family_key = 'gold';
    IF n <> 1 THEN RAISE EXCEPTION 'no payments-list row for the put-back'; END IF;
    r := public.reverse_failed_stripe_refund(c, 're_f1', NULL);
    fam := public.camp_family(c, 'gold');
    IF (r->>'alreadyRecorded')::boolean IS NOT TRUE OR public.family_ledger_balance(fam) <> 0 THEN
        RAISE EXCEPTION 'a re-sent family failure: % owes %', r, public.family_ledger_balance(fam);
    END IF;
    r := public.sync_family_ledger_payments(c, 'gold');
    fam := public.camp_family(c, 'gold');
    IF public.family_ledger_balance(fam) <> 0 THEN
        RAISE EXCEPTION 'the ledger sync posted the put-back a second time: % owes %', r, public.family_ledger_balance(fam);
    END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'refund_failed' AND source_id = 're_f1';
    IF n <> 1 THEN RAISE EXCEPTION 'no Billing notice for the failed family refund'; END IF;

    -- 4. not on these books; nobody but the server
    r := public.reverse_failed_stripe_refund(c, 're_never', 'account closed', 75, 'pi_dash');
    IF r->>'error' IS DISTINCT FROM 'refund_not_found' OR (r->>'firstNotice')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'an unknown refund: %', r; END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'refund_failed' AND source_id = 're_never'
       AND body LIKE '%$75.00%' AND body LIKE '%pi_dash%';
    IF n <> 1 THEN RAISE EXCEPTION 'TED-131: no notice for a failed refund that was not on the books'; END IF;
    r := public.reverse_failed_stripe_refund(c, 're_never', 'account closed', 75, 'pi_dash');
    IF (r->>'firstNotice')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'the same unknown failure noticed twice: %', r; END IF;
    IF has_function_privilege('authenticated', 'public.reverse_failed_stripe_refund(uuid,text,text,numeric,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.reverse_failed_stripe_refund(uuid,text,text,numeric,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can put refunds back';
    END IF;
    IF NOT public.is_money_notice('refund_failed') THEN RAISE EXCEPTION 'the notice is shown to people without Billing'; END IF;
    RAISE NOTICE 'ok  278: canteen put back once / family put back once / sync no double / unknown left alone / grants';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v278 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v278 WHERE item LIKE '278%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 278 row says: %', r; END IF;
END $$;
ROLLBACK;
