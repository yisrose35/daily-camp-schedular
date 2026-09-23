-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 239.
--
-- One question, asked as an attack: can a signed-in user who owns no camp and is
-- a member of none move money at a camp whose id they happen to know?
--
-- Before 239 the answer was yes. The gate read `p_camp_id <> get_user_camp_id()`
-- and the resolver answers NULL for such a caller, so the comparison was NULL,
-- the IF did not fire, and the canteen branch — which has no role list of its own
-- — debited the camper.
--
-- uuids are prefixed a3900000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- auth.uid() has to answer, or every gate here is testing nothing. The stubs
-- define it as a constant NULL because a migration try only needs it to exist;
-- this is Supabase's real definition.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    -- The inner NULLIF is not decoration. A RESET custom GUC reads back as the
    -- EMPTY STRING, and ''::json raises "input string ended unexpectedly" — so an
    -- unauthenticated caller would get an exception where every gate expects NULL.
    -- Supabase's own definition wraps current_setting the same way.
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a3900000-0000-0000-0000-0000000000aa', 'owner@239.test'),
    ('a3900000-0000-0000-0000-0000000000bb', 'stranger@239.test'),
    ('a3900000-0000-0000-0000-0000000000cc', 'member@239.test');

INSERT INTO camps (id, name, owner)
VALUES ('a3900000-0000-0000-0000-000000000001', '239 camp',
        'a3900000-0000-0000-0000-0000000000aa');

-- A camper with $50 on their canteen account, and a shop order to settle.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a3900000-0000-0000-0000-000000000001', 4001, 'camper', 'Kid A', 'Kid A');

INSERT INTO camp_state_kv (camp_id, key, value) VALUES
 ('a3900000-0000-0000-0000-000000000001', 'campistryShop',
  jsonb_build_object('orders', jsonb_build_array(
      jsonb_build_object('id', 'o1', 'camperName', 'Kid A', 'payMethod', 'canteen'),
      jsonb_build_object('id', 'o2', 'camperName', 'Kid A', 'payMethod', 'canteen'))));

SET "request.jwt.claims" = '{"sub":"a3900000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_account_save('a3900000-0000-0000-0000-000000000001'::uuid, 'Kid A',
    '{"balance":50,"dailyLimit":0,"spentToday":0}'::jsonb);


-- ─── 1. the stranger is refused, and takes nothing ──────────────────────────
SET "request.jwt.claims" = '{"sub":"a3900000-0000-0000-0000-0000000000bb"}';
DO $$
DECLARE v jsonb; v_bal numeric;
BEGIN
    -- The precondition that made this reachable: the resolver has no answer for
    -- this caller. If that ever changes the test still holds, but the reason it
    -- was interesting would not.
    IF public.get_user_camp_id() IS NOT NULL THEN
        RAISE EXCEPTION 'the stranger resolved to a camp (%), so this test is not '
                        'exercising what it claims', public.get_user_camp_id();
    END IF;
    -- And get_user_role() is NOT null for them, which is why the second check
    -- never caught it either.
    IF public.get_user_role() IS NULL THEN
        RAISE EXCEPTION 'get_user_role() is NULL for a stranger — the old gate would '
                        'have held and this test proves nothing';
    END IF;

    v := public.settle_shop_order('a3900000-0000-0000-0000-000000000001'::uuid,
                                  'o1', 'canteen', 7.00, false);
    IF COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'A STRANGER SETTLED ANOTHER CAMP''S ORDER: %', v;
    END IF;
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'refused, but for the wrong reason: %', v;
    END IF;

    SELECT balance INTO v_bal FROM camp_canteen_accounts
     WHERE camp_id = 'a3900000-0000-0000-0000-000000000001' AND account_key = 'Kid A';
    IF v_bal <> 50 THEN
        RAISE EXCEPTION 'the balance moved to % — money left the account on a refused call', v_bal;
    END IF;
END $$;


-- ─── 2. an anonymous caller is refused too ──────────────────────────────────
RESET "request.jwt.claims";
DO $$
DECLARE v jsonb;
BEGIN
    v := public.settle_shop_order('a3900000-0000-0000-0000-000000000001'::uuid,
                                  'o1', 'canteen', 7.00, false);
    IF COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'an unauthenticated caller settled an order: %', v;
    END IF;
END $$;


-- ─── 3. the owner still can, which is the point of a gate and not a wall ────
SET "request.jwt.claims" = '{"sub":"a3900000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb; v_bal numeric;
BEGIN
    v := public.settle_shop_order('a3900000-0000-0000-0000-000000000001'::uuid,
                                  'o1', 'canteen', 7.00, false);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the owner was refused — 239 broke the legitimate path: %', v;
    END IF;
    SELECT balance INTO v_bal FROM camp_canteen_accounts
     WHERE camp_id = 'a3900000-0000-0000-0000-000000000001' AND account_key = 'Kid A';
    IF v_bal <> 43 THEN
        RAISE EXCEPTION 'expected 43.00 after a $7 canteen charge, got %', v_bal;
    END IF;
END $$;


-- ─── 4. and so can an accepted team member ──────────────────────────────────
-- camp_staff_member is the new condition, so the caller it must NOT lock out is a
-- staff member who does not own the camp. get_user_camp_id resolves them through
-- their accepted camp_users row.
INSERT INTO camp_users (camp_id, user_id, role, accepted_at)
VALUES ('a3900000-0000-0000-0000-000000000001', 'a3900000-0000-0000-0000-0000000000cc',
        'manager', now());

SET "request.jwt.claims" = '{"sub":"a3900000-0000-0000-0000-0000000000cc"}';
DO $$
DECLARE v jsonb;
BEGIN
    IF public.get_user_camp_id() <> 'a3900000-0000-0000-0000-000000000001' THEN
        RAISE EXCEPTION 'the member does not resolve to the camp, so this check is moot';
    END IF;
    v := public.settle_shop_order('a3900000-0000-0000-0000-000000000001'::uuid,
                                  'o2', 'canteen', 3.00, false);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'an accepted manager was refused: %', v;
    END IF;
END $$;


-- ─── 5. the verifier reports the shape, not a hope ──────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.verify_shop_settlement_gate();
    IF (v->>'gate_is_null_safe')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the verifier does not see a NULL-safe gate: %', v;
    END IF;
    IF (v->>'membership_required')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the verifier does not see the membership check: %', v;
    END IF;
    IF (v->>'old_unsafe_comparison_present')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'the old `<> get_user_camp_id` comparison is still in the body: %', v;
    END IF;
END $$;

ROLLBACK;
