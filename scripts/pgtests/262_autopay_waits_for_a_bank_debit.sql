-- Behaviour test for migration 262 (TED-064): a bank debit in flight is held on
-- the plan, visible to the runner, and released — on the family's ROW.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name) VALUES ('f6260000-0000-0000-0000-000000000001', NULL, 'Bank Camp');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f6260000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'bank', jsonb_build_object('name','Bank','camperIds', jsonb_build_array('Ari Bank'),
     'plans', jsonb_build_array(jsonb_build_object('id','plan_b','autopay',true,
        'dueDates', jsonb_build_array('2026-06-01','2026-07-01'),'count',2,'nextIndex',0,'history','[]'::jsonb))))));

DO $$
DECLARE c uuid := 'f6260000-0000-0000-0000-000000000001'; r jsonb; p jsonb;
BEGIN
    r := public.hold_autopay_charge(c, 'bank', 'plan_b',
            jsonb_build_object('paymentIntentId','pi_ach','index',0,'dueDate','2026-06-01','amount',500,'since','2026-06-01'));
    IF NOT (r ->> 'success')::boolean THEN RAISE EXCEPTION 'hold refused: %', r; END IF;
    p := public.camp_families_object(c) #> '{bank,plans,0}';
    IF p #>> '{pendingCharge,paymentIntentId}' IS DISTINCT FROM 'pi_ach' THEN
        RAISE EXCEPTION 'TED-064: the runner cannot see the held debit on the family row: %', p;
    END IF;
    IF (p ->> 'nextIndex')::int <> 0 OR jsonb_array_length(p -> 'history') <> 0 THEN
        RAISE EXCEPTION 'holding a debit must not advance or record the plan: %', p;
    END IF;
    r := public.hold_autopay_charge(c, 'bank', 'plan_b', NULL);
    IF (public.camp_families_object(c) #> '{bank,plans,0}') ? 'pendingCharge' THEN
        RAISE EXCEPTION 'the hold was not released';
    END IF;
    IF (public.hold_autopay_charge(c, 'bank', 'no_such_plan', NULL) ->> 'error') <> 'plan_not_found' THEN
        RAISE EXCEPTION 'an unknown plan must be refused';
    END IF;
    -- only the server may hold a debit
    IF has_function_privilege('authenticated', 'public.hold_autopay_charge(uuid,text,text,jsonb)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.hold_autopay_charge(uuid,text,text,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a signed-in user can write a hold on a plan';
    END IF;
    RAISE NOTICE 'ok  262: a held debit is on the family row, the plan does not advance, release works, staff cannot write it';
END $$;

-- The owner's checking script says "ok" for 262 once it is applied.
\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v262 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v262 WHERE item LIKE '262%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 262 row says: %', r; END IF;
END $$;
DROP FUNCTION public.hold_autopay_charge(uuid, text, text, jsonb);
DROP TABLE v262;
CREATE TEMP TABLE v262 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v262 WHERE item LIKE '262%';
    IF r NOT LIKE 'apply 262%' THEN RAISE EXCEPTION 'without 262 the checking script says: %', r; END IF;
END $$;
ROLLBACK;
