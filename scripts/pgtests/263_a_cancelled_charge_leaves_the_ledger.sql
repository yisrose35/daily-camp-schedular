-- Behaviour test for migration 263 (TED-066): a Camp Shop order billed to the
-- family and then cancelled leaves the family's balance where it started —
-- through the real settle_shop_order, on the family's row.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2630000-0000-0000-0000-0000000000a1', 'o@263.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2630000-0000-0000-0000-000000000001', 'f2630000-0000-0000-0000-0000000000a1', 'Shop Camp');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('f2630000-0000-0000-0000-000000000001', 1, 'camper', 'Avi Gold', 'Avi Gold');
INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('f2630000-0000-0000-0000-000000000001', 'campistryShop', '{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill"}]}'::jsonb),
('f2630000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
     'entries', jsonb_build_array(
        jsonb_build_object('id','le_t','kind','charge','amount',1000,'reason','tuition'),
        jsonb_build_object('id','le_p','kind','payment','amount',1000,'reason','card'))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t263.uid', true), '')::uuid $f$;
SELECT set_config('t263.uid', 'f2630000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2630000-0000-0000-0000-0000000000a1"}', false);

DO $$
DECLARE c uuid := 'f2630000-0000-0000-0000-000000000001'; r jsonb; bal numeric;
BEGIN
    r := public.settle_shop_order(c, 'o1', 'bill', 40);
    IF NOT (r ->> 'success')::boolean THEN RAISE EXCEPTION 'billing the order failed: %', r; END IF;
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 40 THEN RAISE EXCEPTION 'TED-066: billing a $40 order should owe 40, owes %', bal; END IF;
    -- re-priced
    r := public.settle_shop_order(c, 'o1', 'bill', 55);
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 55 THEN RAISE EXCEPTION 'TED-066: re-pricing to $55 left the balance at %', bal; END IF;
    -- cancelled
    r := public.settle_shop_order(c, 'o1', 'bill', 55, true);
    IF NOT (r ->> 'success')::boolean THEN RAISE EXCEPTION 'cancelling failed: %', r; END IF;
    bal := public.family_ledger_balance(public.camp_families_object(c) -> 'gold');
    IF bal <> 0 THEN RAISE EXCEPTION 'TED-066: a cancelled $55 order still counts — balance %', bal; END IF;
    -- cancelling again changes nothing
    r := public.settle_shop_order(c, 'o1', 'bill', 55, true);
    IF public.family_ledger_balance(public.camp_families_object(c) -> 'gold') <> 0 THEN
        RAISE EXCEPTION 'cancelling twice moved the balance';
    END IF;
    RAISE NOTICE 'ok  263: bill 40 -> 40, re-price 55 -> 55, cancel -> 0, cancel again -> 0';
END $$;

-- a family with no ledger is left alone
DO $$
BEGIN
    IF public._sync_charge_to_ledger('{"charges":[{"id":"x","amount":5}]}'::jsonb, 'x') ? 'entries' THEN
        RAISE EXCEPTION 'a family with no ledger was given one';
    END IF;
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v263 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v263 WHERE item LIKE '263%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 263 row says: %', r; END IF;
END $$;
ROLLBACK;
