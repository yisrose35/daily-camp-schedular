-- Behaviour test for migration 267 (TED-082): a Camp Shop order billed BEFORE
-- a camp converted to the ledger is re-priced and then cancelled through the
-- real settle_shop_order, and the balance follows: 40 -> 55 -> 0.
--   A. a camp converted by the old conversion, repaired by 267's one-off link;
--   B. a camp converting now, through the real convert_family_ledgers;
--   C. an office tab that loaded before the link saves — the link survives.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2670000-0000-0000-0000-0000000000a1', 'o@267.test'), ('f2670000-0000-0000-0000-0000000000a2', 'o2@267.test');
INSERT INTO public.camps (id, owner, name) VALUES
  ('f2670000-0000-0000-0000-000000000001', 'f2670000-0000-0000-0000-0000000000a1', 'Old Conv Camp'),
  ('f2670000-0000-0000-0000-000000000002', 'f2670000-0000-0000-0000-0000000000a2', 'New Conv Camp');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
  ('f2670000-0000-0000-0000-000000000001', 1, 'camper', 'Avi Gold', 'Avi Gold'),
  ('f2670000-0000-0000-0000-000000000002', 1, 'camper', 'Avi Gold', 'Avi Gold');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t267.uid', true), '')::uuid $f$;
SELECT set_config('t267.uid', 'f2670000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2670000-0000-0000-0000-0000000000a1"}', false);

-- A: exactly what the old conversion left: the $40 order, and an unlinked
-- le_conv_ fee for it (plus an unrelated $40 fee dated elsewhere, which must
-- not be the one linked).
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2670000-0000-0000-0000-000000000001', 'campistryShop', '{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill","settlement":{"method":"bill","amount":40}}]}'::jsonb),
('f2670000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
     'charges', jsonb_build_array(
        jsonb_build_object('id','late_1','category','Late Fee','amount',40,'date','2026-06-15'),
        jsonb_build_object('id','shop_o1','category','Camp Shop','amount',40,'date','2026-07-01','shopOrderId','o1')),
     'entries', jsonb_build_array(
        jsonb_build_object('id','le_conv_gold_1','kind','charge','amount',1000,'reason','tuition','source',jsonb_build_object('enrollmentId','e1')),
        jsonb_build_object('id','le_conv_gold_2','kind','charge','amount',40,'reason','fee','date','2026-07-01','source','{}'::jsonb),
        jsonb_build_object('id','le_conv_gold_3','kind','charge','amount',40,'reason','fee','date','2026-06-15','source','{}'::jsonb),
        jsonb_build_object('id','le_conv_gold_4','kind','payment','amount',1000,'reason','card'))))));

CREATE TEMP TABLE tab AS SELECT public.camp_families_object('f2670000-0000-0000-0000-000000000001') -> 'gold' AS copy;

-- the migration's one-off repair, run for real
\i migrations/267_a_converted_charge_knows_its_charge.sql

DO $$
DECLARE c uuid := 'f2670000-0000-0000-0000-000000000001'; f jsonb; bal numeric;
BEGIN
    f := public.camp_families_object(c) -> 'gold';
    IF (SELECT x->'source'->>'chargeId' FROM jsonb_array_elements(f->'entries') x WHERE x->>'id' = 'le_conv_gold_2') IS DISTINCT FROM 'shop_o1'
       OR (SELECT x->'source'->>'chargeId' FROM jsonb_array_elements(f->'entries') x WHERE x->>'id' = 'le_conv_gold_3') IS DISTINCT FROM 'late_1' THEN
        RAISE EXCEPTION 'TED-082: the repair linked the wrong entries: %', f->'entries';
    END IF;
    bal := public.family_ledger_balance(f);
    IF bal <> 80 THEN RAISE EXCEPTION 'the repair moved the balance: %', bal; END IF;
    PERFORM public.settle_shop_order(c, 'o1', 'bill', 55);
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 95 THEN RAISE EXCEPTION 'TED-082 A: re-pricing the $40 order to $55 should owe 40+55=95 (late fee + order), owes %', bal; END IF;
    PERFORM public.settle_shop_order(c, 'o1', 'bill', 55, true);
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 40 THEN RAISE EXCEPTION 'TED-082 A: cancelling the order should leave only the $40 late fee, owes %', bal; END IF;
    RAISE NOTICE 'ok  267 A: repaired camp: order 40 -> 55 -> cancelled; balance 80 -> 95 -> 40';
END $$;

-- running the repair again changes nothing
\i migrations/267_a_converted_charge_knows_its_charge.sql
DO $$
BEGIN
    IF public.family_ledger_balance(public.camp_families_object('f2670000-0000-0000-0000-000000000001') -> 'gold') <> 40 THEN
        RAISE EXCEPTION 'running 267 twice moved the balance';
    END IF;
END $$;

-- C: the tab that loaded before the repair saves (it re-prices nothing); the
-- links stay, so the cancelled order stays cancelled.
DO $$
DECLARE c uuid := 'f2670000-0000-0000-0000-000000000001'; t jsonb; f jsonb; r jsonb;
BEGIN
    SELECT copy INTO t FROM tab;
    t := jsonb_set(t, '{charges}', jsonb_build_array(t->'charges'->0));    -- the order is gone, as the server says
    r := public.sync_camp_billing(c, jsonb_build_object('gold', t), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'the save failed: %', r; END IF;
    f := public.camp_families_object(c) -> 'gold';
    IF (SELECT x->'source'->>'chargeId' FROM jsonb_array_elements(f->'entries') x WHERE x->>'id' = 'le_conv_gold_2') IS DISTINCT FROM 'shop_o1' THEN
        RAISE EXCEPTION 'TED-082 C: an old tab''s save dropped the link: %', f->'entries';
    END IF;
    IF public.family_ledger_balance(f) <> 40 THEN
        RAISE EXCEPTION 'TED-082 C: after the old tab saved the family owes %', public.family_ledger_balance(f);
    END IF;
    RAISE NOTICE 'ok  267 C: an old tab''s save keeps the links';
END $$;

-- B: a camp converting now (its own owner).
SELECT set_config('t267.uid', 'f2670000-0000-0000-0000-0000000000a2', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2670000-0000-0000-0000-0000000000a2"}', false);
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2670000-0000-0000-0000-000000000002', 'campistryShop', '{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill","settlement":{"method":"bill","amount":40}}]}'::jsonb),
('f2670000-0000-0000-0000-000000000002', 'campistryMe', jsonb_build_object(
   'sessions', jsonb_build_array(jsonb_build_object('name','Full','tuition',1000)),
   'enrollments', jsonb_build_object('e1', jsonb_build_object('camperName','Avi Gold','session','Full','status','enrolled')),
   'families', jsonb_build_object('gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
      'charges', jsonb_build_array(jsonb_build_object('id','shop_o1','category','Camp Shop','amount',40,'date','2026-07-01','shopOrderId','o1')))),
   'finance', jsonb_build_object('payments', jsonb_build_array(
      jsonb_build_object('id','p1','familyKey','gold','amount',1000,'status','succeeded','stripePaymentIntentId','pi_1')))));

DO $$
DECLARE c uuid := 'f2670000-0000-0000-0000-000000000002'; r jsonb; bal numeric;
BEGIN
    r := public.convert_family_ledgers(c, false);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'conversion failed: %', r; END IF;
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 40 THEN RAISE EXCEPTION 'after conversion the family should owe 40, owes %', bal; END IF;
    r := public.settle_shop_order(c, 'o1', 'bill', 55);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'B: re-pricing failed: %', r; END IF;
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 55 THEN RAISE EXCEPTION 'TED-082 B: re-pricing to $55 left the balance at % (95 = counted twice)', bal; END IF;
    PERFORM public.settle_shop_order(c, 'o1', 'bill', 55, true);
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 0 THEN RAISE EXCEPTION 'TED-082 B: a cancelled order still counts — balance %', bal; END IF;
    RAISE NOTICE 'ok  267 B: converted now: 40 -> re-price 55 -> cancel 0';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v267 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v267 WHERE item LIKE '267%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 267 row says: %', r; END IF;
END $$;
ROLLBACK;
