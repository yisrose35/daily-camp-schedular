-- Behaviour test for migration 273 (TED-093): "nothing went through" releases
-- a refund claim only once it has waited a few minutes, never a settled one.
\set ON_ERROR_STOP on
INSERT INTO auth.users (id, email) VALUES ('f2730000-0000-0000-0000-0000000000a1', 'o@273.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2730000-0000-0000-0000-000000000001', 'f2730000-0000-0000-0000-0000000000a1', 'Refund Camp');
DO $$
DECLARE c uuid := 'f2730000-0000-0000-0000-000000000001';
BEGIN
    PERFORM public.claim_refund_intent(c, 'rfnd:a', 100, 'X1');
    IF public.release_stale_refund_intent(c, 'rfnd:a') THEN
        RAISE EXCEPTION 'TED-093: a refund claim seconds old (a double-click) was released';
    END IF;
    UPDATE refund_intents SET created_at = now() - interval '4 minutes' WHERE camp_id = c AND key = 'rfnd:a';
    IF NOT public.release_stale_refund_intent(c, 'rfnd:a') THEN
        RAISE EXCEPTION 'an unconfirmed refund claim four minutes old could not be released';
    END IF;
    IF NOT (public.claim_refund_intent(c, 'rfnd:a', 100, 'X1')->>'claimed')::boolean THEN
        RAISE EXCEPTION 'the released claim could not be taken again';
    END IF;
    PERFORM public.settle_refund_intent(c, 'rfnd:a', '{"externalTransactionId":"R1"}'::jsonb);
    UPDATE refund_intents SET created_at = now() - interval '1 hour' WHERE camp_id = c AND key = 'rfnd:a';
    IF public.release_stale_refund_intent(c, 'rfnd:a') THEN RAISE EXCEPTION 'a settled refund was released'; END IF;
    IF has_function_privilege('authenticated', 'public.release_stale_refund_intent(uuid,text,interval)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can release refund claims';
    END IF;
    RAISE NOTICE 'ok  273: young claim kept, old one released, settled one never';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v273 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v273 WHERE item LIKE '273%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 273 row says: %', r; END IF;
END $$;
ROLLBACK;
