-- Behaviour test for migration 268 (TED-083/085/086): the charge claim's
-- answers — new, in progress, settled, stale, retaken — and the attempt number
-- a decline bumps; and processor_transactions takes a registration deposit.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2680000-0000-0000-0000-0000000000a1', 'o@268.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2680000-0000-0000-0000-000000000001', 'f2680000-0000-0000-0000-0000000000a1', 'Claim Camp');

DO $$
DECLARE c uuid := 'f2680000-0000-0000-0000-000000000001'; r jsonb;
    age constant text := 'UPDATE refund_intents SET %s = now() - interval ''11 minutes'' WHERE key = %L';
BEGIN
    -- first try: claimed, attempt 0; a second caller meanwhile: in progress (never "paid")
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1');
    IF NOT (r->>'claimed')::boolean OR (r->>'attempt')::int <> 0 THEN RAISE EXCEPTION 'first claim: %', r; END IF;
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1');
    IF r->>'state' <> 'in_progress' THEN RAISE EXCEPTION 'TED-083: a held claim answered %', r; END IF;

    -- the function died BEFORE asking the processor: after 10 minutes, retaken
    EXECUTE format(age, 'created_at', 'deposit:e1:25000');
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1');
    IF r->>'state' <> 'retaken' THEN RAISE EXCEPTION 'TED-083: a claim abandoned before the processor was asked stayed held: %', r; END IF;

    -- asked, then cut off: stale after 10 minutes, NOT retaken unless the caller will re-ask
    PERFORM public.mark_charge_intent_called(c, 'deposit:e1:25000');
    EXECUTE format(age, 'called_at', 'deposit:e1:25000');
    EXECUTE format(age, 'created_at', 'deposit:e1:25000');
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1');
    IF r->>'state' <> 'stale' THEN RAISE EXCEPTION 'TED-083: a cut-off charge whose outcome is unknown was not flagged: %', r; END IF;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE camp_id = c AND source = 'charge_unconfirmed') THEN
        RAISE EXCEPTION 'TED-092: the office was not told about a stuck charge';
    END IF;
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1', true);
    IF r->>'state' <> 'retaken' OR (r->>'attempt')::int <> 0 THEN
        RAISE EXCEPTION 'TED-083: a caller that re-asks (same key) could not take the stale claim: %', r;
    END IF;
    -- a second confirmation right behind it (two tabs, a double click) charges nothing
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1', true);
    IF r->>'state' <> 'in_progress' THEN
        RAISE EXCEPTION 'TED-092: a second "nothing went through" was also allowed to charge: %', r;
    END IF;

    -- declined: released with a new attempt number (a new Idempotency-Key)
    PERFORM public.release_charge_intent(c, 'deposit:e1:25000', true);
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1');
    IF NOT (r->>'claimed')::boolean OR (r->>'attempt')::int <> 1 THEN RAISE EXCEPTION 'TED-085: after a decline: %', r; END IF;
    -- released without a decline (nothing sent / answer lost): same attempt
    PERFORM public.release_charge_intent(c, 'deposit:e1:25000', false);
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1');
    IF (r->>'attempt')::int <> 1 THEN RAISE EXCEPTION 'a release without a decline changed the attempt: %', r; END IF;

    -- paid: settled, and a settled claim cannot be released or retaken
    PERFORM public.settle_refund_intent(c, 'deposit:e1:25000', '{"txnId":"pi_1"}'::jsonb);
    PERFORM public.release_charge_intent(c, 'deposit:e1:25000', true);
    r := public.claim_charge_intent(c, 'deposit:e1:25000', 250, 'e1', true);
    IF r->>'state' <> 'settled' OR r->'previous'->>'txnId' <> 'pi_1' THEN RAISE EXCEPTION 'a paid deposit: %', r; END IF;

    -- TED-086: the deposit's own record is accepted
    INSERT INTO processor_transactions (camp_id, processor_key, external_transaction_id, kind, amount_cents, status)
    VALUES (c, 'stripe', 'pi_dep', 'registration_deposit', 25000, 'succeeded'),
           (c, 'cardknox', 'ck_cap', 'registration_card_capture', 0, 'succeeded');
    RAISE NOTICE 'ok  268: new / in progress / retaken / stale / re-asked / declined -> attempt 1 / settled; deposits recorded';
END $$;

-- the functions are the service role's only
DO $$
BEGIN
    IF has_function_privilege('authenticated', 'public.claim_charge_intent(uuid,text,numeric,text,boolean)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.release_charge_intent(uuid,text,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can call the charge-claim functions';
    END IF;
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v268 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v268 WHERE item LIKE '268%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 268 row says: %', r; END IF;
END $$;
ROLLBACK;
