-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 233.
--
-- The only thing that matters here is that the BRANCHES RUN. PL/pgSQL resolves a
-- function name at the first execution of the statement calling it, so both of
-- these functions existed, applied cleanly, and raised 42883 the moment their
-- write branch was taken. A test that checks the functions exist proves nothing;
-- a test that calls them and never reaches the write proves nothing either.
--
-- So: charge an installment and read the family back to see the installment
-- marked paid, and settle a shop order to a camp bill and read the charge back.
--
-- uuids are prefixed b3300000- so this file cannot collide with the other
-- pgtests sharing one server.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- ─── a camp, a family with a payment plan, and a shop order ─────────────────
INSERT INTO camps (id, name, owner)
VALUES ('b3300000-0000-0000-0000-000000000001', '233 camp',
        'b3300000-0000-0000-0000-0000000000aa')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''b3300000-0000-0000-0000-0000000000aa''::uuid';
CREATE OR REPLACE FUNCTION public.get_user_camp_id() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''b3300000-0000-0000-0000-000000000001''::uuid';
CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS text LANGUAGE sql STABLE
  AS 'SELECT ''owner''::text';

-- One family, two plan shapes tested in turn. camperIds holds NAMES, which is
-- the shape 211 projects and 234 gives ids to.
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('b3300000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'families', jsonb_build_object(
        'fam_rosen', jsonb_build_object(
            'name', 'Rosen',
            'camperIds', jsonb_build_array('Shop Kid'),
            'plans', jsonb_build_array(jsonb_build_object(
                'id', 'plan_1',
                'installments', jsonb_build_array(
                    jsonb_build_object('dueDate', '2026-07-01', 'amount', 250,
                                       'status', 'pending')))))),
    'finance', '{}'::jsonb))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('b3300000-0000-0000-0000-000000000001', 'campistryShop', jsonb_build_object(
    'orders', jsonb_build_array(jsonb_build_object(
        'id', 'ord_1', 'camperName', 'Shop Kid', 'total', 40))))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;


-- ─── 1. autopay records the charge it made ──────────────────────────────────
-- BEFORE 233 this raised
--   ERROR: function public.camp_family_save(uuid, text, unknown, jsonb)
--          does not exist
-- and charge-due-installments logged "A CARD WAS CHARGED AND IS NOT RECORDED".
DO $$
DECLARE v jsonb;
BEGIN
    v := public.record_autopay_installment(
            'b3300000-0000-0000-0000-000000000001'::uuid,
            'fam_rosen', 'plan_1', 0, '2026-07-01',
            jsonb_build_object('status', 'paid', 'paidAt', '2026-07-01'),
            jsonb_build_object('id', 'pay_1', 'amount', 250, 'familyKey', 'fam_rosen'),
            'pay_1');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'record_autopay_installment failed: %', v;
    END IF;
    IF (v->>'patched')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the installment was not patched, so the next run charges again: %', v;
    END IF;
END $$;

-- And the patch is actually in the family, not just reported.
DO $$
DECLARE v_status text;
BEGIN
    SELECT f.payload #>> '{plans,0,installments,0,status}' INTO v_status
      FROM camp_families f
     WHERE f.camp_id = 'b3300000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_rosen';
    IF v_status IS DISTINCT FROM 'paid' THEN
        RAISE EXCEPTION 'the installment is still %, so tomorrow night charges the card again',
                        COALESCE(v_status, 'missing');
    END IF;
END $$;

-- ─── 1b. and a re-run charges nobody twice ──────────────────────────────────
-- The installment is no longer pending, so the patch branch matches nothing.
-- This is the property the broken call had made untestable: it never got far
-- enough to patch, so every run looked like a first run.
DO $$
DECLARE v jsonb;
BEGIN
    v := public.record_autopay_installment(
            'b3300000-0000-0000-0000-000000000001'::uuid,
            'fam_rosen', 'plan_1', 0, '2026-07-01',
            jsonb_build_object('status', 'paid'),
            jsonb_build_object('id', 'pay_1', 'amount', 250, 'familyKey', 'fam_rosen'),
            'pay_1');
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 're-run failed: %', v;
    END IF;
    IF (v->>'patched')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'a re-run patched an already-paid installment: %', v;
    END IF;
    IF (v->>'alreadyRecorded')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the dedupe key did not stop a second payment row: %', v;
    END IF;
END $$;

-- ─── 1c. the legacy single-plan shape, which is the other broken branch ─────
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('b3300000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'families', jsonb_build_object(
        'fam_legacy', jsonb_build_object(
            'name', 'Legacy',
            'camperIds', jsonb_build_array('Legacy Kid'),
            'plan', jsonb_build_object(
                'installments', jsonb_build_array(
                    jsonb_build_object('dueDate', '2026-07-02', 'amount', 100,
                                       'status', 'pending'))))),
    'finance', '{}'::jsonb))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

DO $$
DECLARE v jsonb; v_status text;
BEGIN
    v := public.record_autopay_installment(
            'b3300000-0000-0000-0000-000000000001'::uuid,
            'fam_legacy', NULL, 0, '2026-07-02',
            jsonb_build_object('status', 'paid'), NULL, NULL);
    IF (v->>'success')::boolean IS NOT TRUE OR (v->>'patched')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the legacy single-plan branch failed: %', v;
    END IF;
    SELECT f.payload #>> '{plan,installments,0,status}' INTO v_status
      FROM camp_families f
     WHERE f.camp_id = 'b3300000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_legacy';
    IF v_status IS DISTINCT FROM 'paid' THEN
        RAISE EXCEPTION 'the legacy plan''s installment is still %',
                        COALESCE(v_status, 'missing');
    END IF;
END $$;


-- ─── 2. a shop order reaches the camp bill ──────────────────────────────────
-- Restore the family that holds Shop Kid, then settle to 'bill'.
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('b3300000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'families', jsonb_build_object(
        'fam_rosen', jsonb_build_object(
            'name', 'Rosen',
            'camperIds', jsonb_build_array('Shop Kid'))),
    'finance', '{}'::jsonb))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

DO $$
DECLARE v jsonb;
BEGIN
    v := public.settle_shop_order('b3300000-0000-0000-0000-000000000001'::uuid,
                                  'ord_1', 'bill', 40, false);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'settling to the camp bill failed: %', v;
    END IF;
    IF v->>'familyKey' IS DISTINCT FROM 'fam_rosen' THEN
        RAISE EXCEPTION 'the order was billed to %, not the family holding the camper: %',
                        COALESCE(v->>'familyKey', 'nobody'), v;
    END IF;
END $$;

-- And the charge is on the family.
DO $$
DECLARE v_amt numeric; v_n integer;
BEGIN
    SELECT count(*), max((c->>'amount')::numeric) INTO v_n, v_amt
      FROM camp_families f
      CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(f.payload->'charges', '[]'::jsonb)) AS c
     WHERE f.camp_id = 'b3300000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_rosen'
       AND c->>'shopOrderId' = 'ord_1';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'expected one Camp Shop charge on the family, found %', v_n;
    END IF;
    IF v_amt <> 40 THEN
        RAISE EXCEPTION 'the charge is % and not 40', v_amt;
    END IF;
END $$;

-- And the REST of the family survived. camp_family_save takes a whole payload,
-- so a writer that passes only the field it changed erases everything else —
-- name, camperIds, the payment plan. The charge assertions above all pass for a
-- family that has been reduced to nothing but charges, which is why this is
-- here.
DO $$
DECLARE v_name text; v_campers jsonb;
BEGIN
    SELECT f.payload->>'name', f.payload->'camperIds' INTO v_name, v_campers
      FROM camp_families f
     WHERE f.camp_id = 'b3300000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_rosen';
    IF v_name IS DISTINCT FROM 'Rosen' THEN
        RAISE EXCEPTION 'settling the order erased the family name (now %)',
                        COALESCE(v_name, 'missing');
    END IF;
    IF v_campers IS DISTINCT FROM '["Shop Kid"]'::jsonb THEN
        RAISE EXCEPTION 'settling the order erased the family''s campers (now %)',
                        COALESCE(v_campers::text, 'missing');
    END IF;
END $$;

-- ─── 2b. re-settling replaces, never stacks ─────────────────────────────────
-- The read-modify-write is the whole reason this path takes a lock, and the
-- broken call meant it had never once executed.
DO $$
DECLARE v jsonb; v_n integer; v_amt numeric;
BEGIN
    v := public.settle_shop_order('b3300000-0000-0000-0000-000000000001'::uuid,
                                  'ord_1', 'bill', 55, false);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 're-settling failed: %', v;
    END IF;
    SELECT count(*), max((c->>'amount')::numeric) INTO v_n, v_amt
      FROM camp_families f
      CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(f.payload->'charges', '[]'::jsonb)) AS c
     WHERE f.camp_id = 'b3300000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_rosen'
       AND c->>'shopOrderId' = 'ord_1';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 're-settling stacked a second sweatshirt: % charges', v_n;
    END IF;
    IF v_amt <> 55 THEN
        RAISE EXCEPTION 're-settling left the old amount: %', v_amt;
    END IF;
END $$;

-- ─── 2c. and cancelling takes it off ────────────────────────────────────────
DO $$
DECLARE v jsonb; v_n integer;
BEGIN
    v := public.settle_shop_order('b3300000-0000-0000-0000-000000000001'::uuid,
                                  'ord_1', 'bill', 0, true);
    IF (v->>'success')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'cancelling failed: %', v;
    END IF;
    SELECT count(*) INTO v_n
      FROM camp_families f
      CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(f.payload->'charges', '[]'::jsonb)) AS c
     WHERE f.camp_id = 'b3300000-0000-0000-0000-000000000001'
       AND f.family_key = 'fam_rosen'
       AND c->>'shopOrderId' = 'ord_1';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'cancelling left % charge(s) on the family', v_n;
    END IF;
END $$;

-- ─── 3. a camper in no family is still refused ──────────────────────────────
-- 167's refusal must survive the fix: an unbilled sweatshirt was the original
-- bug, and a fix that silently drops the charge instead is the same bug wearing
-- a success message.
INSERT INTO camp_state_kv (camp_id, key, value)
VALUES ('b3300000-0000-0000-0000-000000000001', 'campistryShop', jsonb_build_object(
    'orders', jsonb_build_array(
        jsonb_build_object('id', 'ord_1', 'camperName', 'Shop Kid', 'total', 40),
        jsonb_build_object('id', 'ord_2', 'camperName', 'Nobody At All', 'total', 15))))
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

DO $$
DECLARE v jsonb;
BEGIN
    v := public.settle_shop_order('b3300000-0000-0000-0000-000000000001'::uuid,
                                  'ord_2', 'bill', 15, false);
    IF (v->>'error') IS DISTINCT FROM 'no_family_for_camper' THEN
        RAISE EXCEPTION 'a camper in no family was billed anyway: %', v;
    END IF;
END $$;

ROLLBACK;
