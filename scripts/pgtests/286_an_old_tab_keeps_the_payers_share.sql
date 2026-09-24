-- Behaviour test for migration 286 (TED-177): Pine's $1,000 charge is split,
-- $800 to the Scholarship Fund, and the fund's $300 cheque is recorded — all
-- on Pine's family record (payerLedger). A second office computer that loaded
-- Pine before any of that saves Pine again, by both of the page's save paths:
-- the fund's lines are all still there. A later correction (a void line) from
-- the up-to-date computer is kept too.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2860000-0000-0000-0000-0000000000a1', 'o@286.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2860000-0000-0000-0000-000000000001', 'f2860000-0000-0000-0000-0000000000a1', 'Fund Camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
('f2860000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'pine', jsonb_build_object('name','Pine','camperIds', jsonb_build_array('Noa Pine'),
     'entries', jsonb_build_array(jsonb_build_object('id','le_old','kind','charge','amount',100,'reason','tuition'))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t286.uid', true), '')::uuid $f$;
SELECT set_config('t286.uid', 'f2860000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2860000-0000-0000-0000-0000000000a1"}', false);

-- the second computer's copy, from before
CREATE TEMP TABLE stale AS SELECT public.camp_family('f2860000-0000-0000-0000-000000000001', 'pine') AS copy;

DO $$
DECLARE c uuid := 'f2860000-0000-0000-0000-000000000001'; t jsonb; r jsonb; f jsonb; n int;
BEGIN
    -- the up-to-date computer: the split and the fund's cheque
    f := public.camp_family(c, 'pine');
    f := f || jsonb_build_object(
        'charges', '[{"id":"c1","amount":200,"fullAmount":1000,"category":"Tuition"}]'::jsonb,
        'entries', (f->'entries') || '[{"id":"le_chg_c1","kind":"charge","amount":200,"reason":"tuition","source":{"chargeId":"c1"}}]'::jsonb,
        'payerLedger', '[{"id":"prc_c1_org_fund","payerId":"org_fund","kind":"charge","amount":800},
                         {"id":"prp_1","payerId":"org_fund","kind":"payment","paymentId":"prp_1","amount":300}]'::jsonb);
    r := public.sync_camp_billing(c, jsonb_build_object('pine', f), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'the save failed: %', r; END IF;

    -- 1. the stale computer saves Pine by the billing rows (an unrelated edit)
    SELECT copy INTO t FROM stale;
    t := t || jsonb_build_object('note', 'called about the bus');
    r := public.sync_camp_billing(c, jsonb_build_object('pine', t), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'pine');
    SELECT count(*) INTO n FROM jsonb_array_elements(f->'payerLedger') x WHERE x->>'id' IN ('prc_c1_org_fund', 'prp_1');
    IF n <> 2 THEN RAISE EXCEPTION 'TED-177: the stale save dropped the fund''s share or cheque: %', f->'payerLedger'; END IF;
    IF f->>'note' IS DISTINCT FROM 'called about the bus' THEN RAISE EXCEPTION 'the stale computer''s own edit was lost'; END IF;

    -- 2. and by the settings document (the other save path)
    UPDATE camp_state_kv SET value = jsonb_set(value, '{families,pine}', t)
     WHERE camp_id = c AND key = 'campistryMe';
    f := public.camp_family(c, 'pine');
    SELECT count(*) INTO n FROM jsonb_array_elements(f->'payerLedger') x WHERE x->>'id' IN ('prc_c1_org_fund', 'prp_1');
    IF n <> 2 THEN RAISE EXCEPTION 'TED-177: the settings-document save dropped the fund''s lines: %', f->'payerLedger'; END IF;

    -- 3. a correction from the up-to-date computer, then the stale one again
    f := f || jsonb_build_object('payerLedger', (f->'payerLedger') || '[{"id":"prv_prp_1","payerId":"org_fund","kind":"void","voidOf":"prp_1","amount":300}]'::jsonb);
    r := public.sync_camp_billing(c, jsonb_build_object('pine', f), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    r := public.sync_camp_billing(c, jsonb_build_object('pine', t), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'pine');
    IF jsonb_array_length(f->'payerLedger') <> 3 THEN RAISE EXCEPTION 'the correction was lost: %', f->'payerLedger'; END IF;
    RAISE NOTICE 'ok  286: the fund''s share, cheque and correction survive an old computer''s saves, both ways';
END $$;

\i migrations/286_an_old_tab_keeps_the_payers_share.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v286 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v286 WHERE item LIKE '286%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 286 row says: %', r; END IF;
END $$;
ROLLBACK;
