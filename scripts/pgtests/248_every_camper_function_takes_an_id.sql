-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 248: given an id, the id decides — whatever name comes
-- with it. uuids are prefixed a4800000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES ('a4800000-0000-0000-0000-0000000000aa', 'owner@248.test');
INSERT INTO camps (id, name, owner)
VALUES ('a4800000-0000-0000-0000-000000000001', '248 camp', 'a4800000-0000-0000-0000-0000000000aa');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4800000-0000-0000-0000-000000000001', 4801, 'camper', 'Ayala', 'Ayala'),
    ('a4800000-0000-0000-0000-000000000001', 4802, 'camper', 'Bracha', 'Bracha');
SET "request.jwt.claims" = '{"sub":"a4800000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('a4800000-0000-0000-0000-000000000001', 'Ayala', 10);
SELECT public.canteen_office_credit('a4800000-0000-0000-0000-000000000001', 'Bracha', 10);
RESET "request.jwt.claims";

CREATE OR REPLACE FUNCTION pg_temp.bal(pid bigint) RETURNS numeric LANGUAGE sql AS $f$
    SELECT balance FROM camp_canteen_accounts
     WHERE camp_id = 'a4800000-0000-0000-0000-000000000001' AND person_id = pid
$f$;

-- ─── 1. a card credit names Ayala but carries Bracha's id: Bracha is credited
DO $$
DECLARE v jsonb;
BEGIN
    v := public.credit_canteen_balance_from_processor(
            p_camp_id => 'a4800000-0000-0000-0000-000000000001', p_camper_name => 'Ayala',
            p_amount => 5, p_processor_key => 'cardknox', p_external_transaction_id => 'tx-248',
            p_source => 'deposit', p_camper_id => 4802);
    IF NOT COALESCE((v->>'success')::boolean, false) THEN RAISE EXCEPTION 'credit refused: %', v; END IF;
    IF pg_temp.bal(4802) <> 15 OR pg_temp.bal(4801) <> 10 THEN
        RAISE EXCEPTION 'the id did not decide: 4801=% 4802=%', pg_temp.bal(4801), pg_temp.bal(4802);
    END IF;
END $$;

-- ─── 2. an id that is nobody is refused, and nothing moves ──────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.credit_canteen_balance_from_processor(
            p_camp_id => 'a4800000-0000-0000-0000-000000000001', p_camper_name => 'Ayala',
            p_amount => 5, p_processor_key => 'cardknox', p_external_transaction_id => 'tx-248b',
            p_source => 'deposit', p_camper_id => 999999);
    IF v->>'error' IS DISTINCT FROM 'unknown_camper' THEN RAISE EXCEPTION 'unknown id not refused: %', v; END IF;
    IF pg_temp.bal(4801) <> 10 THEN RAISE EXCEPTION 'an unknown id moved money'; END IF;
    IF public.canteen_camper_known('a4800000-0000-0000-0000-000000000001', 'Ayala', 999999) THEN
        RAISE EXCEPTION 'a yes/no check said yes to an unknown id';
    END IF;
END $$;

-- ─── 3. without an id, exactly as before ────────────────────────────────────
DO $$
BEGIN
    PERFORM public.credit_canteen_balance_from_processor(
            'a4800000-0000-0000-0000-000000000001', 'Ayala', 1, 'cardknox', 'tx-248c', 'deposit');
    IF pg_temp.bal(4801) <> 11 THEN RAISE EXCEPTION 'the name-only call no longer works'; END IF;
END $$;

-- ─── 4. a read by id: the history of 4802, asked for under Ayala's name ─────
SET "request.jwt.claims" = '{"sub":"a4800000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb; n int;
BEGIN
    v := public.get_canteen_history('a4800000-0000-0000-0000-000000000001', 'Ayala', NULL, 50, 4802);
    SELECT count(*) INTO n FROM jsonb_array_elements(v->'transactions') t WHERE t->>'camper' = 'Ayala';
    IF n <> 0 OR jsonb_array_length(v->'transactions') < 2 THEN
        RAISE EXCEPTION 'history by id returned the named camper''s rows instead: %', v;
    END IF;
END $$;

-- ─── 5. one signature per name, and none left on names only ─────────────────
DO $$
DECLARE v jsonb := public.verify_every_camper_function_takes_an_id();
BEGIN
    IF v->'name_only' <> '[]'::jsonb THEN RAISE EXCEPTION 'still name-only: %', v; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('credit_canteen_balance_from_processor','get_canteen_history',
                   'verify_my_camper','_parent_owns_camper') GROUP BY proname HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'a wrapped function has two signatures — PostgREST cannot choose';
    END IF;
END $$;

ROLLBACK;
