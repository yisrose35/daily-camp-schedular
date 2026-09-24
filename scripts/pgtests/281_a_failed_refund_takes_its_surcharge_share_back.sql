-- Behaviour test for migration 281 (TED-148, TED-150).
--   1. Slate paid $1,030 ($1,000 + a $30 card surcharge). The office refunded
--      $1,000 and $29.13 of the surcharge came off the bill. Stripe fails the
--      refund; 278 puts the $1,000 back; 281 puts the $29.13 back on the bill:
--      Slate owes nothing and holds no credit, on the ledger and in charges.
--   2. The same failure again changes nothing; another refund's id nothing.
--   3. The platform alert's once-only claim can be given back, so the next
--      delivery claims (and sends) it again.
--   4. A browser can call neither; the checking script's 281 row says ok.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2810000-0000-0000-0000-0000000000a1', 'o@281.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2810000-0000-0000-0000-000000000001', 'f2810000-0000-0000-0000-0000000000a1', 'Fee Camp');

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2810000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'slate', jsonb_build_object('name', 'Slate', 'camperIds', jsonb_build_array('Noa Slate'),
       'charges', jsonb_build_array(
          jsonb_build_object('id', 't1', 'category', 'Tuition', 'amount', 1000),
          jsonb_build_object('id', 'sur_1', 'category', 'Card Fee', 'amount', 30,
                             'cardFee', jsonb_build_object('mode', 'surcharge', 'base', 1000))),
       'credits', jsonb_build_array(
          jsonb_build_object('id', 'cfr_1', 'amount', 29.13, 'reason', 'correction', 'cardFeeReturn', true,
                             'refundId', 're_s1', 'refundOf', 'pi_pi_s'),
          -- another refund's surcharge credit, which went through: never touched
          jsonb_build_object('id', 'cfr_2', 'amount', 10, 'reason', 'correction', 'cardFeeReturn', true,
                             'refundId', 're_ok', 'refundOf', 'pi_pi_s')),
       'entries', jsonb_build_array(
          jsonb_build_object('id', 'le_chg_t1', 'kind', 'charge', 'amount', 1000, 'reason', 'tuition', 'source', jsonb_build_object('chargeId', 't1')),
          jsonb_build_object('id', 'le_chg_sur_1', 'kind', 'charge', 'amount', 30, 'reason', 'fee', 'source', jsonb_build_object('chargeId', 'sur_1')),
          jsonb_build_object('id', 'le_pay_pi_s', 'kind', 'payment', 'amount', 1030, 'reason', 'card', 'source', jsonb_build_object('paymentId', 'pi_s')),
          jsonb_build_object('id', 'le_pay_re_s1', 'kind', 'refund', 'amount', 1000, 'reason', 'refund', 'source', jsonb_build_object('paymentId', 're_s1')),
          jsonb_build_object('id', 'le_cfr_1', 'kind', 'credit', 'amount', 29.13, 'reason', 'correction', 'source', jsonb_build_object('creditId', 'cfr_1')),
          jsonb_build_object('id', 'le_cfr_2', 'kind', 'credit', 'amount', 10, 'reason', 'correction', 'source', jsonb_build_object('creditId', 'cfr_2')))))));

DO $$
DECLARE
    c   uuid := 'f2810000-0000-0000-0000-000000000001';
    r   jsonb;
    fam jsonb;
    n   int;
    b   boolean;
BEGIN
    fam := public.camp_family_for_update(c, 'slate');
    IF public.family_ledger_balance(fam) <> 960.87 THEN
        RAISE EXCEPTION 'setup: Slate should owe $960.87 after the refunds, owes %', public.family_ledger_balance(fam);
    END IF;

    -- 1. the refund fails: the $1,000 back (278), and the $29.13 back (281)
    r := public.reverse_failed_stripe_refund(c, 're_s1', 'expired or canceled card');
    IF (r->>'success')::boolean IS NOT TRUE OR r->>'familyKey' <> 'slate' THEN RAISE EXCEPTION 'put-back: %', r; END IF;
    fam := public.camp_family_for_update(c, 'slate');
    IF public.family_ledger_balance(fam) <> -39.13 THEN
        RAISE EXCEPTION 'setup: after the put-back alone Slate should hold $39.13 of credit, balance %', public.family_ledger_balance(fam);
    END IF;
    r := public.undo_card_fee_return(c, 'slate', 're_s1');
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'undone')::int <> 1 OR (r->>'amount')::numeric <> 29.13 THEN
        RAISE EXCEPTION 'undo: %', r;
    END IF;
    fam := public.camp_family_for_update(c, 'slate');
    IF public.family_ledger_balance(fam) <> -10 THEN
        RAISE EXCEPTION 'TED-148: after the undo Slate should keep only the other refund''s $10 — balance %', public.family_ledger_balance(fam);
    END IF;
    -- only the failed refund's credit came back, not every surcharge credit
    SELECT count(*) INTO n FROM jsonb_array_elements(fam->'charges') x WHERE x->>'id' LIKE 'cfr_undo_%';
    IF n <> 1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(fam->'charges') x WHERE x->>'id' = 'cfr_undo_cfr_2') THEN
        RAISE EXCEPTION 'another refund''s surcharge credit was taken back too: %', fam->'charges';
    END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(fam->'charges') x
     WHERE x->>'id' = 'cfr_undo_cfr_1' AND (x->>'amount')::numeric = 29.13 AND (x->>'cardFeeUndo')::boolean;
    IF n <> 1 THEN RAISE EXCEPTION 'the charge on the bill: %', fam->'charges'; END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(fam->'entries') e
     WHERE e->>'id' = 'le_chg_cfr_undo_cfr_1' AND e->>'kind' = 'charge' AND (e->>'amount')::numeric = 29.13;
    IF n <> 1 THEN RAISE EXCEPTION 'the ledger entry (the id Billing''s catch-up looks for): %', fam->'entries'; END IF;

    -- 2. again, and another refund's id: nothing
    r := public.undo_card_fee_return(c, 'slate', 're_s1');
    IF (r->>'undone')::int <> 0 THEN RAISE EXCEPTION 'the surcharge went back on the bill twice: %', r; END IF;
    r := public.undo_card_fee_return(c, 'slate', 're_other');
    IF (r->>'undone')::int <> 0 THEN RAISE EXCEPTION 'another refund''s failure took this surcharge back: %', r; END IF;
    fam := public.camp_family_for_update(c, 'slate');
    IF public.family_ledger_balance(fam) <> -10 THEN RAISE EXCEPTION 'balance moved on a repeat: %', public.family_ledger_balance(fam); END IF;
    r := public.undo_card_fee_return(c, 'nobody', 're_s1');
    IF r->>'error' IS DISTINCT FROM 'family_not_found' THEN RAISE EXCEPTION 'unknown family: %', r; END IF;

    -- 3. the alert's claim, given back and taken again
    IF NOT public.claim_refund_failure_alert('re_s1') THEN RAISE EXCEPTION 'first claim refused'; END IF;
    IF public.claim_refund_failure_alert('re_s1') THEN RAISE EXCEPTION 'claimed twice'; END IF;
    b := public.release_refund_failure_alert('re_s1');
    IF NOT b THEN RAISE EXCEPTION 'TED-150: the claim could not be given back'; END IF;
    IF NOT public.claim_refund_failure_alert('re_s1') THEN RAISE EXCEPTION 'TED-150: after giving it back, the next delivery cannot send the alert'; END IF;

    -- 4. not from a browser
    IF has_function_privilege('authenticated', 'public.undo_card_fee_return(uuid,text,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.undo_card_fee_return(uuid,text,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.release_refund_failure_alert(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can call the webhook''s functions';
    END IF;
    RAISE NOTICE 'ok  281: surcharge share back with the failed refund, once / alert claim given back and retaken / service only';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v281 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v281 WHERE item LIKE '281%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 281 row says: %', r; END IF;
END $$;
ROLLBACK;
