-- Behaviour test for migration 285 (TED-176): a tip the parent got back.
--   1. A $20 tip, refunded in full: marked, and $20 off the staff member's
--      total — once, however often Stripe says so.
--   2. A $10 tip disputed: the whole $10 off while the bank decides; won: back
--      on; a late "open" does not reopen it.
--   3. Only ever up: an older, smaller refund figure changes nothing.
--   4. The platform's email state: "alerted" until something changes.
--   5. Service role only; the checking script's 285 row says ok.
\set ON_ERROR_STOP on

INSERT INTO camps (id, name, owner) VALUES ('f2850000-0000-0000-0000-000000000001', '285 camp', NULL);
INSERT INTO link_staff_accounts (id, camp_id, staff_name, role, total_earned)
VALUES ('f2850000-0000-0000-0000-0000000000a1', 'f2850000-0000-0000-0000-000000000001', 'Moshe', 'counselor', 30);
INSERT INTO link_tips (id, camp_id, recipient_name, amount, staff_account_id, payment_method, stripe_payment_intent_id) VALUES
    ('f2850000-0000-0000-0000-0000000000b1', 'f2850000-0000-0000-0000-000000000001', 'Moshe', 20, 'f2850000-0000-0000-0000-0000000000a1', 'stripe_connect', 'pi_1'),
    ('f2850000-0000-0000-0000-0000000000b2', 'f2850000-0000-0000-0000-000000000001', 'Moshe', 10, 'f2850000-0000-0000-0000-0000000000a1', 'stripe_connect', 'pi_2');

DO $$
DECLARE
    a  uuid := 'f2850000-0000-0000-0000-0000000000a1';
    t1 uuid := 'f2850000-0000-0000-0000-0000000000b1';
    t2 uuid := 'f2850000-0000-0000-0000-0000000000b2';
    r  jsonb;
    e  numeric;
BEGIN
    -- 1. refunded in full, twice
    r := public.record_tip_reversal(t1, 20, NULL, 20, NULL);
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'change')::numeric <> 20 OR (r->>'alerted')::boolean THEN RAISE EXCEPTION 'refund: %', r; END IF;
    PERFORM public.mark_tip_reversal_alerted(t1, r->>'state');
    r := public.record_tip_reversal(t1, 20, NULL, 20, NULL);
    IF (r->>'change')::numeric <> 0 OR NOT (r->>'alerted')::boolean THEN RAISE EXCEPTION 'the repeat: %', r; END IF;
    SELECT total_earned INTO e FROM link_staff_accounts WHERE id = a;
    IF e <> 10 THEN RAISE EXCEPTION 'TED-176: Moshe''s total after a $20 refund should be $10, is %', e; END IF;
    IF (SELECT refunded_amount FROM link_tips WHERE id = t1) <> 20 OR (SELECT clawed_back_amount FROM link_tips WHERE id = t1) <> 20 THEN
        RAISE EXCEPTION 'the tip is not marked';
    END IF;

    -- 3. an older, smaller figure
    r := public.record_tip_reversal(t1, 5, NULL, 5, NULL);
    IF (SELECT refunded_amount FROM link_tips WHERE id = t1) <> 20 OR (r->>'change')::numeric <> 0 THEN RAISE EXCEPTION 'went down: %', r; END IF;

    -- 2. a dispute
    r := public.record_tip_reversal(t2, 0, 'open', 10, NULL);
    SELECT total_earned INTO e FROM link_staff_accounts WHERE id = a;
    IF e <> 0 OR (r->>'lost')::numeric <> 10 THEN RAISE EXCEPTION 'open dispute: total % / %', e, r; END IF;
    r := public.record_tip_reversal(t2, 0, 'won', NULL, NULL);
    SELECT total_earned INTO e FROM link_staff_accounts WHERE id = a;
    IF e <> 10 OR (r->>'disputeStatus') <> 'won' OR (r->>'alerted')::boolean THEN RAISE EXCEPTION 'won: total % / %', e, r; END IF;
    r := public.record_tip_reversal(t2, 0, 'open', NULL, NULL);
    IF r->>'disputeStatus' <> 'won' THEN RAISE EXCEPTION 'a late "open" reopened a won dispute: %', r; END IF;
    SELECT total_earned INTO e FROM link_staff_accounts WHERE id = a;
    IF e <> 10 THEN RAISE EXCEPTION 'total moved on a late open: %', e; END IF;

    r := public.record_tip_reversal(t2, 0, 'maybe', NULL, NULL);
    IF r->>'error' IS DISTINCT FROM 'bad_dispute_status' THEN RAISE EXCEPTION 'a made-up status: %', r; END IF;
    r := public.record_tip_reversal('f2850000-0000-0000-0000-0000000000ff', 1, NULL, NULL, NULL);
    IF r->>'error' IS DISTINCT FROM 'tip_not_found' THEN RAISE EXCEPTION 'no such tip: %', r; END IF;

    -- 5. not from a browser
    IF has_function_privilege('authenticated', 'public.record_tip_reversal(uuid,numeric,text,numeric,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.record_tip_reversal(uuid,numeric,text,numeric,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.mark_tip_reversal_alerted(uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can call the webhook''s tip functions';
    END IF;
    RAISE NOTICE 'ok  285: refunded and disputed tips marked, off the total once, only ever up, service only';
END $$;

\i migrations/285_a_refunded_or_disputed_tip.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v285 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v285 WHERE item LIKE '285%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 285 row says: %', r; END IF;
END $$;
ROLLBACK;
