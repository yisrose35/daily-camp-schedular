-- Behaviour test for migration 266 (TED-078): an office tab that loaded a
-- family before the server wrote to it cannot undo the server's work — through
-- BOTH of the page's save paths — while the office's own edits still land.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2660000-0000-0000-0000-0000000000a1', 'o@266.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2660000-0000-0000-0000-000000000001', 'f2660000-0000-0000-0000-0000000000a1', 'Tab Camp');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2660000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
     'entries', jsonb_build_array(jsonb_build_object('id','le_t','kind','charge','amount',1000,'reason','tuition')),
     'plans', jsonb_build_array(
        jsonb_build_object('id','plan_1','autopay',true,'dueDates',jsonb_build_array('2026-06-01','2026-07-01'),'nextIndex',0,'history','[]'::jsonb),
        jsonb_build_object('id','plan_x','autopay',true,'dueDates',jsonb_build_array('2026-09-01'),'nextIndex',0))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t266.uid', true), '')::uuid $f$;
SELECT set_config('t266.uid', 'f2660000-0000-0000-0000-0000000000a1', false);

CREATE TEMP TABLE tab AS SELECT public.camp_families_object('f2660000-0000-0000-0000-000000000001') -> 'gold' AS copy;

DO $$
DECLARE c uuid := 'f2660000-0000-0000-0000-000000000001'; t jsonb; p jsonb; r jsonb;
BEGIN
    -- overnight: the runner holds a bank debit, records an instalment, and a
    -- payment lands on the ledger
    PERFORM public.hold_autopay_charge(c, 'gold', 'plan_1',
        '{"paymentIntentId":"pi_ach_1","index":0,"dueDate":"2026-06-01","amount":500,"since":"2026-06-01"}'::jsonb);
    PERFORM public.camp_family_save(c, 'gold', jsonb_set(jsonb_set(jsonb_set(
        public.camp_family(c, 'gold'), '{plans,0,nextIndex}', '1'),
        '{plans,0,history}', '[{"index":0,"charged":500}]'),
        '{entries}', (public.camp_family(c, 'gold')->'entries') || '[{"id":"le_pay_x","kind":"payment","amount":200,"reason":"card"}]'::jsonb));

    -- next morning, the old tab adds a $10 charge and deletes plan_x
    SELECT copy INTO t FROM tab;
    t := t || jsonb_build_object('charges', '[{"id":"c_10","amount":10,"category":"Other"}]'::jsonb);
    t := jsonb_set(t, '{plans}', jsonb_build_array(t->'plans'->0));
    r := public.sync_camp_billing(c, jsonb_build_object('gold', t), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'the save failed: %', r; END IF;

    p := public.camp_family(c, 'gold');
    IF p #>> '{plans,0,pendingCharge,paymentIntentId}' IS DISTINCT FROM 'pi_ach_1' THEN
        RAISE EXCEPTION 'TED-078: an old tab wiped the bank-debit hold: %', p->'plans'->0;
    END IF;
    IF (p #>> '{plans,0,nextIndex}')::int <> 1 OR jsonb_array_length(p #> '{plans,0,history}') <> 1 THEN
        RAISE EXCEPTION 'TED-078: an old tab rewound the plan: %', p->'plans'->0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'entries') e WHERE e->>'id' = 'le_pay_x') THEN
        RAISE EXCEPTION 'TED-078: an old tab wiped a payment from the ledger';
    END IF;
    IF public.family_ledger_balance(p) <> 800 THEN RAISE EXCEPTION 'balance wrong after merge: %', public.family_ledger_balance(p); END IF;
    -- the office's own edits land
    IF p #>> '{charges,0,id}' IS DISTINCT FROM 'c_10' THEN RAISE EXCEPTION 'the office''s charge was lost'; END IF;
    IF jsonb_array_length(p->'plans') <> 1 THEN RAISE EXCEPTION 'the plan the office cancelled came back: %', p->'plans'; END IF;
    IF public.plan_due_for(c, 'gold', 'plan_1', '2026-06-02') IS NOT NULL
       AND (public.plan_due_for(c, 'gold', 'plan_1', '2026-06-02') ->> 'index')::int = 0 THEN
        RAISE EXCEPTION 'the runner would charge instalment 0 again';
    END IF;
    RAISE NOTICE 'ok  266 (sync_camp_billing): hold, counter, history and ledger survive an old tab; office edits land';
END $$;

-- the same through the settings-document save (the projection trigger)
DO $$
DECLARE c uuid := 'f2660000-0000-0000-0000-000000000001'; t jsonb; p jsonb;
BEGIN
    SELECT copy INTO t FROM tab;
    t := t || jsonb_build_object('charges', '[{"id":"c_11","amount":5,"category":"Other"}]'::jsonb);
    UPDATE camp_state_kv SET value = jsonb_set(value, '{families,gold}', t)
     WHERE camp_id = c AND key = 'campistryMe';
    p := public.camp_family(c, 'gold');
    IF p #>> '{plans,0,pendingCharge,paymentIntentId}' IS DISTINCT FROM 'pi_ach_1' THEN
        RAISE EXCEPTION 'TED-078: the settings save wiped the bank-debit hold';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'entries') e WHERE e->>'id' = 'le_pay_x') THEN
        RAISE EXCEPTION 'TED-078: the settings save wiped a ledger payment';
    END IF;
    IF p #>> '{charges,0,id}' IS DISTINCT FROM 'c_11' THEN RAISE EXCEPTION 'the settings save lost the office''s edit'; END IF;
    RAISE NOTICE 'ok  266 (settings save): the same';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v266 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v266 WHERE item LIKE '266%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 266 row says: %', r; END IF;
END $$;
ROLLBACK;
