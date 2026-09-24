-- Behaviour test for migration 269 (TED-084): a bank debit is held — and a plan
-- flagged — on the old single `plan` and on a listed plan with no id, through
-- the real functions; a position never reaches a plan that has an id; and an
-- office tab that loaded before the hold cannot undo it on either shape.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2690000-0000-0000-0000-0000000000a1', 'o@269.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2690000-0000-0000-0000-000000000001', 'f2690000-0000-0000-0000-0000000000a1', 'Old Plans Camp');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2690000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'old', jsonb_build_object('name','Old','camperIds', jsonb_build_array('A'),
     'plan', jsonb_build_object('autopay', true, 'installments', jsonb_build_array(
        jsonb_build_object('dueDate','2026-07-01','amount',500,'status','pending')))),
  'mixed', jsonb_build_object('name','Mixed','camperIds', jsonb_build_array('B'),
     'plans', jsonb_build_array(
        jsonb_build_object('id','p_has_id','autopay',true,'installments','[]'::jsonb),
        jsonb_build_object('autopay',true,'installments', jsonb_build_array(
           jsonb_build_object('dueDate','2026-07-01','amount',500,'status','pending'))))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t269.uid', true), '')::uuid $f$;
SELECT set_config('t269.uid', 'f2690000-0000-0000-0000-0000000000a1', false);

CREATE TEMP TABLE tab AS SELECT public.camp_families_object('f2690000-0000-0000-0000-000000000001') AS copy;

DO $$
DECLARE c uuid := 'f2690000-0000-0000-0000-000000000001'; r jsonb; f jsonb;
    h jsonb := '{"paymentIntentId":"pi_ach","dueDate":"2026-07-01","amount":500,"since":"2026-07-01"}';
BEGIN
    -- the old single plan, by '#0'
    r := public.hold_autopay_charge(c, 'old', '#0', h);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'TED-084: the old single plan could not hold: %', r; END IF;
    f := public.camp_family(c, 'old');
    IF f->'plan'->'pendingCharge'->>'paymentIntentId' IS DISTINCT FROM 'pi_ach' THEN
        RAISE EXCEPTION 'TED-084: the hold is not on the old plan: %', f;
    END IF;
    -- a listed plan with no id, by position
    r := public.hold_autopay_charge(c, 'mixed', '#1', h);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'TED-084: an id-less plan could not hold: %', r; END IF;
    IF public.camp_family(c, 'mixed')->'plans'->1->'pendingCharge'->>'paymentIntentId' IS DISTINCT FROM 'pi_ach' THEN
        RAISE EXCEPTION 'TED-084: the hold is not on plans[1]';
    END IF;
    -- a position never reaches a plan that has an id
    r := public.hold_autopay_charge(c, 'mixed', '#0', h);
    IF (r->>'success')::boolean THEN RAISE EXCEPTION 'a position was allowed to hold on a plan with an id'; END IF;
    IF public.camp_family(c, 'mixed')->'plans'->0 ? 'pendingCharge' THEN RAISE EXCEPTION 'the plan with an id was held by position'; END IF;
    -- by id still works
    r := public.hold_autopay_charge(c, 'mixed', 'p_has_id', h);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'holding by id broke: %', r; END IF;
    PERFORM public.hold_autopay_charge(c, 'mixed', 'p_has_id', NULL);

    -- the office is told, on the old plan too
    r := public.flag_plan_collection(c, 'old', '#0', 'bank_debit_stuck', 'still processing');
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'TED-084: the old plan could not be flagged: %', r; END IF;
    IF public.camp_family(c, 'old')->'plan'->'collectionBlocked'->>'reason' IS DISTINCT FROM 'bank_debit_stuck' THEN
        RAISE EXCEPTION 'the flag is not on the old plan';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE camp_id = c AND source = 'autopay_blocked'
                    AND body LIKE '%has not cleared for over ten days%') THEN
        RAISE EXCEPTION 'the office notification does not say what happened';
    END IF;
    RAISE NOTICE 'ok  269: old single plan and id-less plan hold and flag; a position never reaches a plan with an id';
END $$;

-- the old tab saves: both holds survive
DO $$
DECLARE c uuid := 'f2690000-0000-0000-0000-000000000001'; t jsonb; r jsonb;
BEGIN
    SELECT copy INTO t FROM tab;
    r := public.sync_camp_billing(c, t, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'the save failed: %', r; END IF;
    IF NOT (public.camp_family(c, 'old')->'plan' ? 'pendingCharge') THEN
        RAISE EXCEPTION 'TED-084: an old tab''s save dropped the old plan''s hold — it would be debited again';
    END IF;
    IF NOT (public.camp_family(c, 'mixed')->'plans'->1 ? 'pendingCharge') THEN
        RAISE EXCEPTION 'TED-084: an old tab''s save dropped the id-less plan''s hold';
    END IF;
    RAISE NOTICE 'ok  269: an old tab''s save keeps the holds on both shapes';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v269 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v269 WHERE item LIKE '269%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 269 row says: %', r; END IF;
END $$;
ROLLBACK;
