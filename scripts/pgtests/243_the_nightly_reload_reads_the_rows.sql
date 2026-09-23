-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 243: the payment edge functions' two reads, from the rows.
--
--   1. canteen_autoreload_accounts lists live accounts with auto-reload ON, and
--      nothing else — not switched-off ones, not departed ones
--   2. after a rename it hands on the CURRENT name, and that name, passed to the
--      real credit function, credits THAT child — even when a different child
--      has since taken the old spelling
--   3. an unattributed account whose key is now somebody else's name is
--      flagged unresolvable instead of handed on
--   4. canteen_camper_known: roster camper with no account yet → yes; an
--      account → yes; a stranger's name → no
--   5. neither is callable by a signed-in user
--
-- uuids are prefixed a4300000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name, owner)
VALUES ('a4300000-0000-0000-0000-000000000001', '243 camp', NULL);

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4300000-0000-0000-0000-000000000001', 4301, 'camper', 'Reload On',  'Reload On'),
    ('a4300000-0000-0000-0000-000000000001', 4302, 'camper', 'Reload Off', 'Reload Off'),
    ('a4300000-0000-0000-0000-000000000001', 4303, 'camper', 'Renamed',    'Renamed'),
    ('a4300000-0000-0000-0000-000000000001', 4305, 'camper', 'No Account', 'No Account');

SELECT public.canteen_account_save('a4300000-0000-0000-0000-000000000001'::uuid, 'Reload On',
    '{"balance":2,"autoReload":{"enabled":true,"cardOnFile":true,"byopCustomerRef":"r1"}}'::jsonb);
SELECT public.canteen_account_save('a4300000-0000-0000-0000-000000000001'::uuid, 'Reload Off',
    '{"balance":2,"autoReload":{"enabled":false}}'::jsonb);
SELECT public.canteen_account_save('a4300000-0000-0000-0000-000000000001'::uuid, 'Renamed',
    '{"balance":1,"autoReload":{"enabled":true,"cardOnFile":true,"byopCustomerRef":"r3"}}'::jsonb);
-- Unattributed: an account nobody on the roster answers to.
SELECT public.canteen_account_save('a4300000-0000-0000-0000-000000000001'::uuid, 'Old Orphan',
    '{"balance":0,"autoReload":{"enabled":true,"cardOnFile":true,"byopCustomerRef":"r4"}}'::jsonb);


-- ─── 1. only live accounts with auto-reload on ──────────────────────────────
DO $$
DECLARE keys text;
BEGIN
    SELECT string_agg(account_key, ',' ORDER BY account_key) INTO keys
      FROM public.canteen_autoreload_accounts('a4300000-0000-0000-0000-000000000001');
    IF keys IS DISTINCT FROM 'Old Orphan,Reload On,Renamed' THEN
        RAISE EXCEPTION 'expected Old Orphan, Reload On, Renamed; got %', keys;
    END IF;
    UPDATE camp_canteen_accounts SET deleted_at = now()
     WHERE camp_id = 'a4300000-0000-0000-0000-000000000001' AND account_key = 'Reload On';
    IF EXISTS (SELECT 1 FROM public.canteen_autoreload_accounts('a4300000-0000-0000-0000-000000000001')
                WHERE account_key = 'Reload On') THEN
        RAISE EXCEPTION 'a departed camper''s card would still be charged';
    END IF;
    UPDATE camp_canteen_accounts SET deleted_at = NULL
     WHERE camp_id = 'a4300000-0000-0000-0000-000000000001' AND account_key = 'Reload On';
END $$;


-- ─── 2. a rename, and a different child taking the old name ─────────────────
UPDATE camp_people SET name = 'Renamed Now', source_key = 'Renamed Now'
 WHERE camp_id = 'a4300000-0000-0000-0000-000000000001' AND person_id = 4303;
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a4300000-0000-0000-0000-000000000001', 4304, 'camper', 'Renamed', 'Renamed');
SELECT public.canteen_account_save('a4300000-0000-0000-0000-000000000001'::uuid, 'Renamed',
    '{"balance":50}'::jsonb);   -- lands on 4304's own account, since "Renamed" is 4304 now

DO $$
DECLARE r record; v jsonb;
BEGIN
    SELECT * INTO r FROM public.canteen_autoreload_accounts('a4300000-0000-0000-0000-000000000001')
     WHERE person_id = 4303;
    IF r.camper_name IS DISTINCT FROM 'Renamed Now' THEN
        RAISE EXCEPTION 'the reader handed on % — not the renamed camper''s current name', r.camper_name;
    END IF;
    IF NOT r.resolvable THEN
        RAISE EXCEPTION 'an attributed account was flagged unresolvable';
    END IF;

    -- What the edge function does next: charge the card, then credit by that name.
    v := public.credit_canteen_balance_from_processor(
            'a4300000-0000-0000-0000-000000000001'::uuid, r.camper_name, 20,
            'cardknox', 'txn-243-1', 'autoreload');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the credit failed: %', v;
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = 'a4300000-0000-0000-0000-000000000001' AND person_id = 4303) <> 21 THEN
        RAISE EXCEPTION 'the reload did not reach the renamed camper (4303): %',
            (SELECT jsonb_agg(jsonb_build_object('key', account_key, 'pid', person_id, 'bal', balance))
               FROM camp_canteen_accounts WHERE camp_id = 'a4300000-0000-0000-0000-000000000001');
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts
         WHERE camp_id = 'a4300000-0000-0000-0000-000000000001' AND person_id = 4304) <> 50 THEN
        RAISE EXCEPTION 'the child who now carries the old name was credited for somebody else''s card';
    END IF;
END $$;


-- ─── 3. an unattributed key that is now somebody's name ─────────────────────
DO $$
DECLARE ok boolean;
BEGIN
    SELECT resolvable INTO ok FROM public.canteen_autoreload_accounts('a4300000-0000-0000-0000-000000000001')
     WHERE account_key = 'Old Orphan';
    IF ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'an unattributed account nobody else answers to should be resolvable';
    END IF;
    INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
    VALUES ('a4300000-0000-0000-0000-000000000001', 4306, 'camper', 'Old Orphan', 'Old Orphan');
    -- The account stays unattributed (attribution never re-points), but the name
    -- now resolves to 4306 — handing it on would credit 4306.
    UPDATE camp_canteen_accounts SET person_id = NULL
     WHERE camp_id = 'a4300000-0000-0000-0000-000000000001' AND account_key = 'Old Orphan';
    SELECT resolvable INTO ok FROM public.canteen_autoreload_accounts('a4300000-0000-0000-0000-000000000001')
     WHERE account_key = 'Old Orphan';
    IF ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'an unattributed key that is now another child''s name was not flagged';
    END IF;
END $$;


-- ─── 4. canteen_camper_known ────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT public.canteen_camper_known('a4300000-0000-0000-0000-000000000001', 'No Account') THEN
        RAISE EXCEPTION 'a roster camper with no account yet was refused — their first deposit opens it';
    END IF;
    IF NOT public.canteen_camper_known('a4300000-0000-0000-0000-000000000001', 'Reload Off') THEN
        RAISE EXCEPTION 'a camper with an account was refused';
    END IF;
    IF public.canteen_camper_known('a4300000-0000-0000-0000-000000000001', 'Nobody Here') THEN
        RAISE EXCEPTION 'a name that is neither a camper nor an account was accepted';
    END IF;
    IF public.canteen_camper_known('a4300000-0000-0000-0000-00000000dead', 'Reload Off') THEN
        RAISE EXCEPTION 'a camper at one camp was accepted for another';
    END IF;
END $$;


-- ─── 5. service only ────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb := public.verify_canteen_rows_for_edge();
BEGIN
    IF (v->>'autoreload_reader')::boolean IS NOT TRUE OR (v->>'camper_check')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'verifier: %', v;
    END IF;
    IF (v->'service_only_functions_open_to_users') ?| ARRAY[
           'canteen_autoreload_accounts(uuid)', 'canteen_camper_known(uuid,text)'] THEN
        RAISE EXCEPTION 'a signed-in user can call one of 243''s service-only reads: %', v;
    END IF;
END $$;

ROLLBACK;
