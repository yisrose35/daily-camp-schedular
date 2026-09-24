-- Behaviour test for migration 271.
--   TED-088  the parent's balance follows a Zelle payment and an autopay charge
--            with no office save in between;
--   TED-077  a check recorded and a Zelle payment posted BEFORE the family's
--            ledger started are on it once it starts, and the completeness
--            check sees the real payments;
--   TED-089  a deposit can be owed, and recorded, straight after applying.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES
  ('f2710000-0000-0000-0000-0000000000a1', 'o@271.test'),
  ('f2710000-0000-0000-0000-0000000000c1', 'p@271.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2710000-0000-0000-0000-000000000001', 'f2710000-0000-0000-0000-0000000000a1', 'Parent Camp');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t271.uid', true), '')::uuid $f$;
SELECT set_config('t271.uid', 'f2710000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2710000-0000-0000-0000-0000000000a1"}', false);

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2710000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
  'sessions', '[{"name":"Full","tuition":1000}]'::jsonb,
  'enrollments', '{"e1":{"camperName":"Avi Gold","status":"enrolled","session":"Full","sessionTuition":1000}}'::jsonb,
  'families', jsonb_build_object(
    'gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
       'entries', jsonb_build_array(jsonb_build_object('id','le_t','kind','charge','amount',1000,'reason','tuition','source',jsonb_build_object('enrollmentId','e1'))),
       'plans', jsonb_build_array(jsonb_build_object('id','plan_1','autopay',true,'dueDates',jsonb_build_array('2026-06-01','2026-07-01'),'nextIndex',0))),
    'blue', jsonb_build_object('name','Blue','camperIds', jsonb_build_array('Dov Blue')))));
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
VALUES ('f2710000-0000-0000-0000-000000000001', 'f2710000-0000-0000-0000-0000000000c1', 'p@271.test', '["Avi Gold"]', 'active');

-- ── TED-088: the parent follows the server, with no office save ───────────
DO $$
DECLARE c uuid := 'f2710000-0000-0000-0000-000000000001'; b jsonb;
BEGIN
    PERFORM public._deposit_record(c, 'fp271', 40000,
        '{"date":"2026-05-30","payerName":"GOLD","kind":"zelle"}'::jsonb,
        '{"decision":"auto","familyKey":"gold","confidence":95}'::jsonb);
    PERFORM public.record_autopay_charge(c, 'gold', 'plan_1', 0, '2026-06-01', 300, 'pi_271');
    IF public.family_ledger_balance(public.camp_family(c, 'gold')) <> 300 THEN
        RAISE EXCEPTION 'the office should see 300, sees %', public.family_ledger_balance(public.camp_family(c, 'gold'));
    END IF;
    PERFORM set_config('t271.uid', 'f2710000-0000-0000-0000-0000000000c1', false);
    PERFORM set_config('request.jwt.claims', '{"sub":"f2710000-0000-0000-0000-0000000000c1"}', false);
    b := public.get_my_balance(c);
    PERFORM set_config('t271.uid', 'f2710000-0000-0000-0000-0000000000a1', false);
    PERFORM set_config('request.jwt.claims', '{"sub":"f2710000-0000-0000-0000-0000000000a1"}', false);
    IF NOT COALESCE((b->>'ledger')::boolean, false) OR (b->>'balance')::numeric <> 300 THEN
        RAISE EXCEPTION 'TED-088: after a $400 Zelle payment and a $300 autopay the parent sees %', b;
    END IF;
    RAISE NOTICE 'ok  271 TED-088: office 300, parent 300 — no office save needed';
END $$;

-- ── TED-077: money before the ledger started ──────────────────────────────
DO $$
DECLARE c uuid := 'f2710000-0000-0000-0000-000000000001'; f jsonb; r jsonb;
BEGIN
    -- a $300 check recorded, and a $100 Zelle posted, while Blue has no ledger
    r := public.sync_camp_billing(c, '{}'::jsonb, '[]'::jsonb,
        '[{"id":"pay_b1","familyKey":"blue","family":"Blue","amount":300,"method":"Check","status":"paid","date":"2026-05-20"}]'::jsonb,
        '[]'::jsonb);
    PERFORM public._deposit_record(c, 'fp271b', 10000,
        '{"date":"2026-05-21","payerName":"BLUE","kind":"zelle"}'::jsonb,
        '{"decision":"auto","familyKey":"blue","confidence":95}'::jsonb);
    -- Billing's first render starts the ledger with the tuition charge
    f := public.camp_family(c, 'blue') || jsonb_build_object('entries', jsonb_build_array(
        jsonb_build_object('id','le_tb','kind','charge','amount',1000,'reason','tuition','date','2026-05-22')));
    r := public.sync_camp_billing(c, jsonb_build_object('blue', f), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'blue');
    IF public.family_ledger_balance(f) <> 600 THEN
        RAISE EXCEPTION 'TED-077: the money that came before the ledger is missing — balance % (entries %)',
            public.family_ledger_balance(f), f->'entries';
    END IF;
    IF NOT public.family_payments_all_posted(f, public.projected_family_payments(c, 'blue'), 'blue') THEN
        RAISE EXCEPTION 'the completeness check disagrees with a complete ledger';
    END IF;
    -- and the completeness check really reads the payments now (158 emptied its old list)
    IF jsonb_array_length(public.projected_family_payments(c, 'blue')) <> 1 THEN
        RAISE EXCEPTION 'TED-077: the completeness check does not see the recorded payment';
    END IF;
    -- saving again posts nothing twice
    r := public.sync_camp_billing(c, jsonb_build_object('blue', f), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF public.family_ledger_balance(public.camp_family(c, 'blue')) <> 600 THEN RAISE EXCEPTION 'posted twice'; END IF;
    RAISE NOTICE 'ok  271 TED-077: a check and a Zelle from before the ledger are on it (600), once';
END $$;

-- ── TED-089: a deposit straight after applying ────────────────────────────
DO $$
DECLARE c uuid := 'f2710000-0000-0000-0000-000000000001'; r jsonb; id text := 'enr_2710aaaabbbbccccddddeeeeffff0000';
BEGIN
    r := public.submit_public_application(c, 'enrollments', id,
        '{"camperName":"New Kid","session":"Full","status":"applied","depositRequired":250}'::jsonb);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'submit failed: %', r; END IF;
    r := public._registration_deposit_owed(c, id);
    IF NOT (r->>'success')::boolean OR (r->>'owed')::numeric <> 250 THEN
        RAISE EXCEPTION 'TED-089: a new application''s deposit could not be found: %', r;
    END IF;
    r := public._record_registration_deposit(c, id, 250, 'pi_dep_271');
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'TED-089: the paid deposit could not be recorded: %', r; END IF;
    r := public._registration_deposit_owed(c, id);
    IF (r->>'owed')::numeric <> 0 THEN RAISE EXCEPTION 'the deposit still reads owed: %', r; END IF;
    IF (SELECT payload->>'depositProcessor' FROM camp_applications WHERE camp_id = c AND entry_id = id) <> 'stripe' THEN
        RAISE EXCEPTION 'the processor that took the deposit was not recorded';
    END IF;
    IF (SELECT jsonb_array_length(payload->'depositCharges') FROM camp_applications WHERE camp_id = c AND entry_id = id) IS DISTINCT FROM 1
       OR (SELECT payload->'depositCharges'->0->>'ref' FROM camp_applications WHERE camp_id = c AND entry_id = id) <> 'pi_dep_271'
       OR (SELECT (payload->'depositCharges'->0->>'amount')::numeric FROM camp_applications WHERE camp_id = c AND entry_id = id) <> 250 THEN
        RAISE EXCEPTION 'TED-090: the card charge was not listed on the application';
    END IF;
    IF (public._record_registration_deposit(c, id, 250, 'pi_dep_271')->>'duplicate')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'recording the same deposit twice was not recognised';
    END IF;
    r := public._record_registration_card(c, id, 'stripe', 'cus_x', 'pm_x', '4242');
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'the card could not be kept: %', r; END IF;
    -- once the office holds it in the document, the document is written too
    UPDATE camp_state_kv SET value = jsonb_set(value, ARRAY['enrollments', id],
        (SELECT payload FROM camp_applications WHERE camp_id = c AND entry_id = id) - 'depositReference' || '{"depositPaid":0}'::jsonb)
     WHERE camp_id = c AND key = 'campistryMe';
    PERFORM public._record_registration_deposit(c, id, 250, 'pi_dep_271b');
    IF (SELECT value #>> ARRAY['enrollments', id, 'depositReference'] FROM camp_state_kv WHERE camp_id = c AND key = 'campistryMe') <> 'pi_dep_271b' THEN
        RAISE EXCEPTION 'an absorbed application''s deposit was not recorded in the document';
    END IF;
    RAISE NOTICE 'ok  271 TED-089: owed 250 straight after applying, recorded, owed 0, processor kept';
END $$;

-- TED-098: the office absorbed an application before the parent paid, the
-- parent pays (camp_applications), then the office's stale copy is saved
DO $$
DECLARE c uuid := 'f2710000-0000-0000-0000-000000000001'; r jsonb; id text := 'enr_2710bbbbccccddddeeeeffff00001111';
BEGIN
    PERFORM public.submit_public_application(c, 'enrollments', id,
        '{"camperName":"Late Kid","session":"Full","status":"applied","depositRequired":250}'::jsonb);
    UPDATE camp_state_kv SET value = jsonb_set(value, ARRAY['enrollments', id],
        '{"camperName":"Late Kid","session":"Full","status":"accepted","depositRequired":250}'::jsonb)
     WHERE camp_id = c AND key = 'campistryMe';                       -- the office's copy, unpaid
    -- the parent pays through a path that finds only the table (as a webhook
    -- that ran before the office's save would have)
    UPDATE camp_applications SET payload = payload || '{"depositPaid":250,"depositReference":"9001","depositStatus":"paid","depositCharges":[{"ref":"9001","amount":250}]}'::jsonb
     WHERE camp_id = c AND entry_id = id;
    r := public._registration_deposit_owed(c, id);
    IF (r->>'owed')::numeric <> 0 THEN RAISE EXCEPTION 'TED-098: a paid deposit reads unpaid after an old tab saved: %', r; END IF;
    -- a second charge anyway (the office's own button): both charges are kept
    PERFORM public._record_registration_deposit(c, id, 250, '9002');
    IF public._deposit_charge_count(public._application_entry(c, id)) <> 2 THEN
        RAISE EXCEPTION 'TED-098: the first charge was lost from the record: %', public._application_entry(c, id)->'depositCharges';
    END IF;
    RAISE NOTICE 'ok  271 TED-098: an old tab cannot make a paid deposit unpaid; no charge is dropped';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v271 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v271 WHERE item LIKE '271%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 271 row says: %', r; END IF;
END $$;
ROLLBACK;
