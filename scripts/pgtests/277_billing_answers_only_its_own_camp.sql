-- Behaviour test for migration 277: a camp's billing answers only its own
-- office. A signed-in stranger and a parent are refused by the three office
-- functions; the owner is served; the server-only writers cannot be called by
-- a browser at all.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES
  ('f2770000-0000-0000-0000-0000000000a1', 'owner@277.test'),
  ('f2770000-0000-0000-0000-0000000000b1', 'stranger@277.test'),
  ('f2770000-0000-0000-0000-0000000000c1', 'parent@277.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2770000-0000-0000-0000-000000000001', 'f2770000-0000-0000-0000-0000000000a1', 'Own Camp');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t277.uid', true), '')::uuid $f$;
SELECT set_config('t277.uid', 'f2770000-0000-0000-0000-0000000000a1', false);

INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2770000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object('gold', jsonb_build_object('name', 'Gold', 'camperIds', jsonb_build_array('Avi Gold'))),
  'finance', jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('id', 'pay_1', 'familyKey', 'gold', 'amount', 500, 'date', '2026-06-01')))));
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
VALUES ('f2770000-0000-0000-0000-000000000001', 'f2770000-0000-0000-0000-0000000000c1', 'parent@277.test', '["Avi Gold"]', 'active');

DO $$
DECLARE c uuid := 'f2770000-0000-0000-0000-000000000001'; r jsonb; who text;
BEGIN
    -- the owner is served
    r := public.get_camp_families(c);
    IF (r->>'success')::boolean IS NOT TRUE OR NOT (r->'families' ? 'gold') THEN RAISE EXCEPTION 'owner read: %', r; END IF;

    FOREACH who IN ARRAY ARRAY['f2770000-0000-0000-0000-0000000000b1', 'f2770000-0000-0000-0000-0000000000c1'] LOOP
        PERFORM set_config('t277.uid', who, false);
        r := public.get_camp_families(c);
        IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN
            RAISE EXCEPTION 'a signed-in non-member (%) read every family of another camp: %', who, left(r::text, 200);
        END IF;
        r := public.get_camp_payments(c);
        IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN
            RAISE EXCEPTION 'a signed-in non-member (%) read every payment of another camp: %', who, left(r::text, 200);
        END IF;
        r := public.sync_camp_billing(c, '{"gold":{"name":"Gold","entries":[{"id":"x","kind":"payment","amount":99999}]}}'::jsonb,
                                      '[]'::jsonb, '[{"id":"fake","familyKey":"gold","amount":99999}]'::jsonb, '["pay_1"]'::jsonb);
        IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN
            RAISE EXCEPTION 'a signed-in non-member (%) wrote another camp''s billing: %', who, r;
        END IF;
    END LOOP;

    -- nothing they sent landed
    PERFORM set_config('t277.uid', 'f2770000-0000-0000-0000-0000000000a1', false);
    IF EXISTS (SELECT 1 FROM camp_payments WHERE camp_id = c AND payload->>'id' = 'fake')
       OR NOT EXISTS (SELECT 1 FROM camp_payments WHERE camp_id = c AND payload->>'id' = 'pay_1' AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'a refused billing save changed the camp''s payments';
    END IF;
    r := public.sync_camp_billing(c, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'the owner''s own save was refused: %', r; END IF;

    -- the server-only functions
    IF has_function_privilege('authenticated', 'public.append_camp_payment(uuid,jsonb,text,jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.record_autopay_installment(uuid,text,text,integer,text,jsonb,jsonb,text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.sync_family_ledger_payments(uuid,text,boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.parent_billing_slice(uuid,jsonb,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can still call a server-only billing function';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.append_camp_payment(uuid,jsonb,text,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the payment webhooks can no longer record a payment';
    END IF;
    RAISE NOTICE 'ok  277: owner served; stranger and parent refused read and write; server-only writers closed to browsers';
END $$;

-- the parent's own balance still works (get_my_balance calls parent_billing_slice as the definer)
DO $$
DECLARE r jsonb;
BEGIN
    PERFORM set_config('t277.uid', 'f2770000-0000-0000-0000-0000000000c1', false);
    r := public.get_my_balance('f2770000-0000-0000-0000-000000000001');
    IF r IS NULL OR r ? 'error' AND r->>'error' ~ 'permission' THEN
        RAISE EXCEPTION 'the parent lost their own balance: %', r;
    END IF;
    RAISE NOTICE 'ok  277: the parent still reads their own balance';
END $$;

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v277 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v277 WHERE item LIKE '277%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 277 row says: %', r; END IF;
END $$;
ROLLBACK;
