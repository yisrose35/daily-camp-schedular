-- Behaviour test for migration 289 (TED-192): a register sale keeps what it
-- sold, by item id, and a void restocks by those ids.
--   1. "Trail Mix 2 ×2, Chips, BBQ" sold with its item list: the line keeps
--      soldItems; voiding it puts 2 Trail Mix 2 and 1 "Chips, BBQ" back — and
--      no more than that, whatever the page asks.
--   2. A register that has not reloaded (no item list) still charges, once.
--   3. 283 pasted again afterwards leaves one version of the charge; the
--      checking script's 283, 284 and 289 rows say ok.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;
INSERT INTO auth.users (id, email) VALUES ('f2890000-0000-0000-0000-0000000000aa', 'owner@289.test');
INSERT INTO camps (id, name, owner) VALUES ('f2890000-0000-0000-0000-000000000001', '289 camp', 'f2890000-0000-0000-0000-0000000000aa');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES ('f2890000-0000-0000-0000-000000000001', 8901, 'camper', 'Avi', 'Avi');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2890000-0000-0000-0000-000000000001', 'campistrySnacks',
    '{"inventory":[{"id":11,"name":"Trail Mix 2","price":2,"stock":5},{"id":12,"name":"Chips, BBQ","price":1,"stock":5}]}'::jsonb);
SET "request.jwt.claims" = '{"sub":"f2890000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('f2890000-0000-0000-0000-000000000001', 'Avi', 20);

DO $$
DECLARE c uuid := 'f2890000-0000-0000-0000-000000000001'; r jsonb; s text; inv jsonb; n int;
BEGIN
    r := public.submit_canteen_purchase_once(c, 'k1', 'Avi', 5, 'Trail Mix 2 ×2, Chips, BBQ', NULL, 8901, '[{"id":11,"qty":2},{"id":12,"qty":1},{"id":"bad"}]'::jsonb);
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'sale: %', r; END IF;
    SELECT sig INTO s FROM canteen_transactions WHERE camp_id = c AND tx_type = 'debit' AND payload ? 'soldItems';
    IF s IS NULL THEN RAISE EXCEPTION 'TED-192: the sale did not keep what it sold'; END IF;
    r := public.canteen_void_sale(c, s, '[{"id":11,"qty":50},{"id":12,"qty":50}]'::jsonb, NULL);
    SELECT value->'inventory' INTO inv FROM camp_state_kv WHERE camp_id = c AND key = 'campistrySnacks';
    IF (r->>'restocked')::int <> 3 OR (inv->0->>'stock')::numeric <> 7 OR (inv->1->>'stock')::numeric <> 6 THEN
        RAISE EXCEPTION 'TED-192: restocked by id, capped at the sale: % / %', r, inv;
    END IF;

    -- 2. an old register: no item list
    r := public.submit_canteen_purchase_once(p_camp_id => c, p_sale_key => 'k2', p_camper_name => 'Avi', p_amount => 1, p_items => 'Chips, BBQ', p_camper_id => 8901);
    r := public.submit_canteen_purchase_once(p_camp_id => c, p_sale_key => 'k2', p_camper_name => 'Avi', p_amount => 1, p_items => 'Chips, BBQ', p_camper_id => 8901);
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND tx_type = 'debit' AND amount = 1;
    IF n <> 1 OR (r->>'replayed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'an old register''s sale: % / %', n, r; END IF;
    RAISE NOTICE 'ok  289: the sale keeps its items by id; the void restocks them, capped; old registers still charge once';
END $$;
RESET "request.jwt.claims";

-- 3. 283 pasted again
\i migrations/283_a_register_sale_is_charged_once.sql
DO $$
BEGIN
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'submit_canteen_purchase_once') <> 1 THEN
        RAISE EXCEPTION 'pasting 283 again left two versions of the charge';
    END IF;
END $$;
\i migrations/289_a_register_sale_keeps_what_it_sold.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v289 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT string_agg(item || ' : ' || result, ' | ') INTO r FROM v289 WHERE (item LIKE '283%' OR item LIKE '284%' OR item LIKE '289%') AND result <> 'ok';
    IF r IS NOT NULL THEN RAISE EXCEPTION 'the checking script says: %', r; END IF;
END $$;
ROLLBACK;
