-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 250: the refund functions can read what they refund.
--
--   1. canteen_refund_view answers the service role (the refund functions'
--      client) — which get_canteen_accounts refuses — and nobody else
--   2. every account carries its camperId
--   3. every deposit, for all time (not the Snacks page's 7-day window), and
--      no sales
--   4. the hosted-payment link can remember WHICH camper (person_id)
--
-- uuids are prefixed a5000000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES ('a5000000-0000-0000-0000-0000000000aa', 'owner@250.test');
INSERT INTO camps (id, name, owner)
VALUES ('a5000000-0000-0000-0000-000000000001', '250 camp', 'a5000000-0000-0000-0000-0000000000aa');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a5000000-0000-0000-0000-000000000001', 5001, 'camper', 'Mine', 'Mine');

SET "request.jwt.claims" = '{"sub":"a5000000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('a5000000-0000-0000-0000-000000000001', 'Mine', 20);
SELECT public.submit_canteen_purchase('a5000000-0000-0000-0000-000000000001', 'Mine', 3, 'Chips');
RESET "request.jwt.claims";

-- A card deposit made weeks ago — outside the Snacks page's window.
INSERT INTO canteen_transactions (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, payload)
VALUES ('a5000000-0000-0000-0000-000000000001', 'old-deposit', 'Mine', '5001', 'credit', 50,
        ((now() AT TIME ZONE 'utc')::date - 60)::text, '{"paymentIntentId":"pi_old"}');

-- ─── 1. the service role, and only it ───────────────────────────────────────
DO $$
BEGIN
    IF has_function_privilege('authenticated', 'public.canteen_refund_view(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.canteen_refund_view(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'every deposit of every camper is readable by a signed-in user';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', 'public.canteen_refund_view(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the refund functions cannot call it';
    END IF;
END $$;

-- ─── 2 + 3. what it answers ─────────────────────────────────────────────────
DO $$
DECLARE v jsonb := public.canteen_refund_view('a5000000-0000-0000-0000-000000000001');
BEGIN
    IF (v->'accounts'->'Mine'->>'camperId') IS DISTINCT FROM '5001' THEN
        RAISE EXCEPTION 'the account does not carry its camperId: %', v->'accounts';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t
                    WHERE t->>'paymentIntentId' = 'pi_old' OR t->'payload'->>'paymentIntentId' = 'pi_old'
                       OR (t->>'amount')::numeric = 50) THEN
        RAISE EXCEPTION 'a 60-day-old deposit is missing — a refund could not find it: %', v->'transactions';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t WHERE t->>'type' = 'debit') THEN
        RAISE EXCEPTION 'sales came back in the refund view: %', v->'transactions';
    END IF;
    IF jsonb_array_length(v->'transactions') <> 2 THEN
        RAISE EXCEPTION 'expected the 2 deposits: %', v->'transactions';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t WHERE t->>'camperId' IS DISTINCT FROM '5001') THEN
        RAISE EXCEPTION 'a deposit carries no camper id to match by: %', v->'transactions';
    END IF;
END $$;

-- ─── 4. the pending link has a person_id ────────────────────────────────────
DO $$
BEGIN
    IF to_regclass('public.banquest_pending_links') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'banquest_pending_links' AND column_name = 'person_id') THEN
        RAISE EXCEPTION 'banquest_pending_links has no person_id';
    END IF;
END $$;

ROLLBACK;
