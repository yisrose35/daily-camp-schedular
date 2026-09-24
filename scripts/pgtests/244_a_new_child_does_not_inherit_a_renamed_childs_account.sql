-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 244: a rename, then a new child with the old name.
--
-- Chaya Levy (4401) has $30. She is renamed Chaya Levi. A different Chaya Levy
-- (4402) arrives. Every canteen writer, called for the NEW child by name, must
-- reach a fresh account of her own — and never the first child's $30.
--
-- uuids are prefixed a4400000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES ('a4400000-0000-0000-0000-0000000000aa', 'owner@244.test');
INSERT INTO camps (id, name, owner)
VALUES ('a4400000-0000-0000-0000-000000000001', '244 camp', 'a4400000-0000-0000-0000-0000000000aa');

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a4400000-0000-0000-0000-000000000001', 4401, 'camper', 'Chaya Levy', 'Chaya Levy');
SELECT public.canteen_account_save('a4400000-0000-0000-0000-000000000001'::uuid, 'Chaya Levy',
    '{"balance":30,"dailyLimit":0}'::jsonb);

UPDATE camp_people SET name = 'Chaya Levi', source_key = 'Chaya Levi'
 WHERE camp_id = 'a4400000-0000-0000-0000-000000000001' AND person_id = 4401;
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a4400000-0000-0000-0000-000000000001', 4402, 'camper', 'Chaya Levy', 'Chaya Levy');

CREATE OR REPLACE FUNCTION pg_temp.bal(pid bigint) RETURNS numeric LANGUAGE sql AS $f$
    SELECT balance FROM camp_canteen_accounts
     WHERE camp_id = 'a4400000-0000-0000-0000-000000000001' AND person_id = pid
$f$;


-- ─── 1. the key ─────────────────────────────────────────────────────────────
DO $$
DECLARE k text;
BEGIN
    k := public.canteen_account_key_for('a4400000-0000-0000-0000-000000000001', 'Chaya Levy');
    IF k IS DISTINCT FROM 'Chaya Levy #4402' THEN
        RAISE EXCEPTION 'the new child resolved to key % — the first child''s account is "Chaya Levy"', k;
    END IF;
    k := public.canteen_account_key_for('a4400000-0000-0000-0000-000000000001', 'Chaya Levi');
    IF k IS DISTINCT FROM 'Chaya Levy' THEN
        RAISE EXCEPTION 'the renamed child lost her own account: key %', k;
    END IF;
    IF public._attribute_canteen_account('a4400000-0000-0000-0000-000000000001', 'Chaya Levy #4402')
       IS DISTINCT FROM 4402 THEN
        RAISE EXCEPTION 'a "#<id>" key is not attributed to that id';
    END IF;
END $$;


-- ─── 2. a deposit for the new child, through the desk ───────────────────────
SET "request.jwt.claims" = '{"sub":"a4400000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.canteen_office_credit('a4400000-0000-0000-0000-000000000001', 'Chaya Levy', 10);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN RAISE EXCEPTION 'deposit refused: %', v; END IF;
    IF pg_temp.bal(4402) IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'the new child''s deposit did not open her own account (4402: %)', pg_temp.bal(4402);
    END IF;
    IF pg_temp.bal(4401) IS DISTINCT FROM 30 THEN
        RAISE EXCEPTION 'the new child''s deposit landed on the renamed child: 4401 now %', pg_temp.bal(4401);
    END IF;
END $$;


-- ─── 3. a register sale for the new child ───────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.submit_canteen_purchase('a4400000-0000-0000-0000-000000000001', 'Chaya Levy', 4, 'Chips');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN RAISE EXCEPTION 'sale refused: %', v; END IF;
    IF pg_temp.bal(4402) <> 6 OR pg_temp.bal(4401) <> 30 THEN
        RAISE EXCEPTION 'the sale moved the wrong balance: 4402=% 4401=%', pg_temp.bal(4402), pg_temp.bal(4401);
    END IF;
    -- and the ledger row is the new child's
    IF NOT EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = 'a4400000-0000-0000-0000-000000000001'
                      AND camper_id = '4402' AND tx_type = 'debit') THEN
        RAISE EXCEPTION 'the sale''s ledger row does not carry the new child''s id';
    END IF;
END $$;


-- ─── 4. an online credit for the renamed child still reaches HER ────────────
RESET "request.jwt.claims";
DO $$
DECLARE v jsonb;
BEGIN
    v := public.credit_canteen_balance_from_processor(
            'a4400000-0000-0000-0000-000000000001', 'Chaya Levi', 5, 'cardknox', 'txn-244', 'deposit');
    IF pg_temp.bal(4401) <> 35 OR pg_temp.bal(4402) <> 6 THEN
        RAISE EXCEPTION 'the renamed child''s credit went astray: 4401=% 4402=%', pg_temp.bal(4401), pg_temp.bal(4402);
    END IF;
END $$;


-- ─── 5. one account per child, and the verifier ─────────────────────────────
DO $$
DECLARE n int; v jsonb;
BEGIN
    SELECT count(*) INTO n FROM camp_canteen_accounts
     WHERE camp_id = 'a4400000-0000-0000-0000-000000000001';
    IF n <> 2 THEN RAISE EXCEPTION 'expected two accounts, found %', n; END IF;
    v := public.verify_renamed_accounts_are_safe('a4400000-0000-0000-0000-000000000001');
    IF (v->>'key_for_mints_a_key')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'verifier does not see the fix: %', v;
    END IF;
    IF (v->>'accounts_whose_old_name_is_now_someone_else')::int <> 1 THEN
        RAISE EXCEPTION 'verifier should count the renamed child''s account: %', v;
    END IF;
END $$;

ROLLBACK;
