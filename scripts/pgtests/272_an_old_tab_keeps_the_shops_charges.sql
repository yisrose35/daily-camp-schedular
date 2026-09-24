-- Behaviour test for migration 272 (TED-091): the shop bills a $40 order after
-- an office tab loaded the family; the tab adds a $10 charge and saves. The
-- order survives (1,050 owed), and a later cancel still takes it off. Also
-- (TED-094): re-running 266 or 269 on their own leaves 272's merge in place.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2720000-0000-0000-0000-0000000000a1', 'o@272.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2720000-0000-0000-0000-000000000001', 'f2720000-0000-0000-0000-0000000000a1', 'Shop Tab Camp');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('f2720000-0000-0000-0000-000000000001', 1, 'camper', 'Avi Gold', 'Avi Gold');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
('f2720000-0000-0000-0000-000000000001', 'campistryShop', '{"orders":[{"id":"o1","camperName":"Avi Gold","camperId":1,"payMethod":"bill"}]}'::jsonb),
('f2720000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'gold', jsonb_build_object('name','Gold','camperIds', jsonb_build_array('Avi Gold'),
     'entries', jsonb_build_array(jsonb_build_object('id','le_t','kind','charge','amount',1000,'reason','tuition','source',jsonb_build_object('enrollmentId','e1')))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t272.uid', true), '')::uuid $f$;
SELECT set_config('t272.uid', 'f2720000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2720000-0000-0000-0000-0000000000a1"}', false);

CREATE TEMP TABLE tab AS SELECT public.camp_family('f2720000-0000-0000-0000-000000000001', 'gold') AS copy;

\i migrations/266_an_old_tab_cannot_undo_the_server.sql
\i migrations/269_every_plan_can_hold_a_bank_debit.sql

DO $$
DECLARE c uuid := 'f2720000-0000-0000-0000-000000000001'; t jsonb; r jsonb; f jsonb;
BEGIN
    IF pg_get_functiondef('public._merge_family_from_page(jsonb,jsonb)'::regprocedure) !~ 'shop' THEN
        RAISE EXCEPTION 'TED-094: re-running 266/269 put back an older merge';
    END IF;
    r := public.settle_shop_order(c, 'o1', 'bill', 40);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'billing the order failed: %', r; END IF;
    -- the old tab adds $10 the way Add Charge does (charges[] and the ledger) and saves
    SELECT copy INTO t FROM tab;
    t := t || jsonb_build_object('charges', '[{"id":"c10","amount":10,"category":"Other"}]'::jsonb,
                                 'entries', (t->'entries') || '[{"id":"le_chg_c10","kind":"charge","amount":10,"reason":"other","source":{"chargeId":"c10"}}]'::jsonb);
    r := public.sync_camp_billing(c, jsonb_build_object('gold', t), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'the save failed: %', r; END IF;
    f := public.camp_family(c, 'gold');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f->'charges') x WHERE x->>'id' = 'shop_o1') THEN
        RAISE EXCEPTION 'TED-091: the old tab''s save dropped the shop order: %', f->'charges';
    END IF;
    IF public.family_ledger_balance(f) <> 1050 THEN RAISE EXCEPTION 'owes %, not 1050', public.family_ledger_balance(f); END IF;
    -- a later cancel still comes off, and the same old tab saving again does not bring it back
    r := public.settle_shop_order(c, 'o1', 'bill', 40, true);
    r := public.sync_camp_billing(c, jsonb_build_object('gold', t || jsonb_build_object('charges',
             '[{"id":"c10","amount":10,"category":"Other"},{"id":"shop_o1","amount":40,"category":"Camp Shop"}]'::jsonb)),
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'gold');
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(f->'charges') x WHERE x->>'id' = 'shop_o1') THEN
        RAISE EXCEPTION 'TED-091: a stale tab brought back a cancelled shop order';
    END IF;
    IF public.family_ledger_balance(f) <> 1010 THEN RAISE EXCEPTION 'after the cancel owes %, not 1010', public.family_ledger_balance(f); END IF;
    RAISE NOTICE 'ok  272: the shop order survives an old tab (1050), a cancel still counts (1010)';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v272 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT string_agg(item || ': ' || result, '; ') INTO r FROM v272 WHERE item ~ '^2(6[6-9]|7[0-2])' AND result <> 'ok';
    IF r IS NOT NULL THEN RAISE EXCEPTION 'the checking script says: %', r; END IF;
END $$;
ROLLBACK;
