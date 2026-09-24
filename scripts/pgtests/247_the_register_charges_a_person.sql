-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 247: the register's charge.
--
--   1. someone invited but never accepted cannot charge
--   2. an accepted member can
--   3. given an id, the PERSON is charged, whatever name comes with it
--   4. an id that is nobody is refused, and nothing moves
--   5. one signature, so PostgREST can call it
--
-- uuids are prefixed a4700000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a4700000-0000-0000-0000-0000000000aa', 'owner@247.test'),
    ('a4700000-0000-0000-0000-0000000000bb', 'invited@247.test'),
    ('a4700000-0000-0000-0000-0000000000cc', 'register@247.test');
INSERT INTO camps (id, name, owner)
VALUES ('a4700000-0000-0000-0000-000000000001', '247 camp', 'a4700000-0000-0000-0000-0000000000aa');
INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES
    ('a4700000-0000-0000-0000-000000000001', 'a4700000-0000-0000-0000-0000000000bb', 'counselor', NULL),
    ('a4700000-0000-0000-0000-000000000001', 'a4700000-0000-0000-0000-0000000000cc', 'counselor', now());

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4700000-0000-0000-0000-000000000001', 4701, 'camper', 'Ayala', 'Ayala'),
    ('a4700000-0000-0000-0000-000000000001', 4702, 'camper', 'Bracha', 'Bracha');

SET "request.jwt.claims" = '{"sub":"a4700000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('a4700000-0000-0000-0000-000000000001', 'Ayala', 20);
SELECT public.canteen_office_credit('a4700000-0000-0000-0000-000000000001', 'Bracha', 20);

CREATE OR REPLACE FUNCTION pg_temp.bal(pid bigint) RETURNS numeric LANGUAGE sql AS $f$
    SELECT balance FROM camp_canteen_accounts
     WHERE camp_id = 'a4700000-0000-0000-0000-000000000001' AND person_id = pid
$f$;


-- ─── 1. an unaccepted invitation cannot charge ──────────────────────────────
SET "request.jwt.claims" = '{"sub":"a4700000-0000-0000-0000-0000000000bb"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.submit_canteen_purchase('a4700000-0000-0000-0000-000000000001', 'Ayala', 5, 'Chips');
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'an invitation nobody accepted charged a camper: %', v;
    END IF;
    IF pg_temp.bal(4701) <> 20 THEN RAISE EXCEPTION 'the refused charge moved money'; END IF;
END $$;


-- ─── 2 + 3. the register (accepted) charges the PERSON ──────────────────────
SET "request.jwt.claims" = '{"sub":"a4700000-0000-0000-0000-0000000000cc"}';
DO $$
DECLARE v jsonb;
BEGIN
    -- The name says Ayala; the id says Bracha. The id wins.
    v := public.submit_canteen_purchase('a4700000-0000-0000-0000-000000000001', 'Ayala', 3, 'Soda',
                                        NULL, 4702);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN RAISE EXCEPTION 'the register was refused: %', v; END IF;
    IF pg_temp.bal(4702) <> 17 OR pg_temp.bal(4701) <> 20 THEN
        RAISE EXCEPTION 'the id did not decide who was charged: 4701=% 4702=%', pg_temp.bal(4701), pg_temp.bal(4702);
    END IF;
    -- And a page that has not reloaded — five named args, no id — still works.
    v := public.submit_canteen_purchase(p_camp_id => 'a4700000-0000-0000-0000-000000000001',
                                        p_camper_name => 'Ayala', p_amount => 2,
                                        p_items => 'Gum', p_date => NULL);
    IF pg_temp.bal(4701) <> 18 THEN RAISE EXCEPTION 'the name-only call no longer works: %', v; END IF;
END $$;


-- ─── 4. an id that is nobody ────────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.submit_canteen_purchase('a4700000-0000-0000-0000-000000000001', 'Ayala', 1, 'x', NULL, 999999);
    IF v->>'error' IS DISTINCT FROM 'unknown_camper' THEN
        RAISE EXCEPTION 'an unknown id was not refused: %', v;
    END IF;
    IF pg_temp.bal(4701) <> 18 THEN RAISE EXCEPTION 'an unknown id moved money'; END IF;
END $$;


-- ─── 5. one signature ───────────────────────────────────────────────────────
DO $$
BEGIN
    IF (SELECT count(*) FROM pg_proc WHERE proname = 'submit_canteen_purchase') <> 1 THEN
        RAISE EXCEPTION 'more than one submit_canteen_purchase — PostgREST returns PGRST203 to every register';
    END IF;
END $$;

ROLLBACK;
