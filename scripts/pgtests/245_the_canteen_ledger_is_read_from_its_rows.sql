-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 245: the ledger comes from canteen_transactions.
--
--   1. staff see today's sales (written by the real writers), not the frozen
--      document's list — and old document rows do NOT come back
--   2. the staff window: 7 days, newest first, and it says when it truncated
--   3. every account carries its camperId
--   4. a parent sees their own child's rows, by ID — including after a rename,
--      and NOT another child who has since taken the old name
--
-- uuids are prefixed a4500000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a4500000-0000-0000-0000-0000000000aa', 'owner@245.test'),
    ('a4500000-0000-0000-0000-0000000000bb', 'parent@245.test');
INSERT INTO camps (id, name, owner)
VALUES ('a4500000-0000-0000-0000-000000000001', '245 camp', 'a4500000-0000-0000-0000-0000000000aa');

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4500000-0000-0000-0000-000000000001', 4501, 'camper', 'Mine',  'Mine'),
    ('a4500000-0000-0000-0000-000000000001', 4502, 'camper', 'Other', 'Other');

-- The frozen document, carrying a row nothing wrote since 219.
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
 ('a4500000-0000-0000-0000-000000000001', 'campistrySnacks',
  '{"transactions":[{"camper":"Mine","amount":99,"type":"debit","date":"2020-01-01","items":"FROZEN"}]}');

-- The parent's invite for "Mine" — 223 stamps its person id.
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
VALUES ('a4500000-0000-0000-0000-000000000001', 'a4500000-0000-0000-0000-0000000000bb',
        'parent@245.test', '["Mine"]', 'active');

-- Real writes, as the owner at the desk and the register.
SET "request.jwt.claims" = '{"sub":"a4500000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('a4500000-0000-0000-0000-000000000001', 'Mine', 20);
SELECT public.canteen_office_credit('a4500000-0000-0000-0000-000000000001', 'Other', 20);
SELECT public.submit_canteen_purchase('a4500000-0000-0000-0000-000000000001', 'Mine', 3, 'Chips');
SELECT public.submit_canteen_purchase('a4500000-0000-0000-0000-000000000001', 'Other', 4, 'Soda');


-- ─── 1 + 3. staff read the rows ─────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_canteen_accounts('a4500000-0000-0000-0000-000000000001');
    IF jsonb_array_length(v->'transactions') <> 4 THEN
        RAISE EXCEPTION 'staff should see the 4 rows written today: %', v->'transactions';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t WHERE t->>'items' = 'FROZEN') THEN
        RAISE EXCEPTION 'the frozen document''s row came back — the reader still reads the blob';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t
                    WHERE t->>'items' = 'Chips' AND t->>'camperId' = '4501') THEN
        RAISE EXCEPTION 'today''s sale is missing or carries no camper id: %', v->'transactions';
    END IF;
    IF (v->'accounts'->'Mine'->>'camperId') IS DISTINCT FROM '4501' THEN
        RAISE EXCEPTION 'the account does not carry its camperId: %', v->'accounts';
    END IF;
    IF (v->'ledgerWindow'->>'truncated')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'four rows reported as truncated: %', v->'ledgerWindow';
    END IF;
END $$;


-- ─── 2. the window ──────────────────────────────────────────────────────────
INSERT INTO canteen_transactions (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, payload)
VALUES ('a4500000-0000-0000-0000-000000000001', 'old-1', 'Mine', '4501', 'debit', 1,
        ((now() AT TIME ZONE 'utc')::date - 30)::text, '{}');
DO $$
DECLARE v jsonb; first_date text;
BEGIN
    v := public.get_canteen_accounts('a4500000-0000-0000-0000-000000000001');
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t WHERE t->>'sig' = 'old-1') THEN
        RAISE EXCEPTION 'a 30-day-old row came back to the staff page';
    END IF;
    first_date := v->'transactions'->0->>'date';
    IF first_date IS DISTINCT FROM (now() AT TIME ZONE 'utc')::date::text THEN
        RAISE EXCEPTION 'newest first: expected today first, got %', first_date;
    END IF;
END $$;


-- ─── 4. the parent, by id, through a rename and a reused name ───────────────
UPDATE camp_people SET name = 'Mine Renamed', source_key = 'Mine Renamed'
 WHERE camp_id = 'a4500000-0000-0000-0000-000000000001' AND person_id = 4501;
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a4500000-0000-0000-0000-000000000001', 4503, 'camper', 'Mine', 'Mine');
SELECT public.canteen_office_credit('a4500000-0000-0000-0000-000000000001', 'Mine', 7);  -- the NEW Mine
-- and the Me page refreshes the family's invite to the new name, as saveCamper
-- does on a rename (223's trigger restamps it: "Mine Renamed" → 4501). His rows
-- are still written under "Mine", so only an ID match still finds them.
UPDATE link_parent_invites SET camper_names = '["Mine Renamed"]'
 WHERE camp_id = 'a4500000-0000-0000-0000-000000000001';

SET "request.jwt.claims" = '{"sub":"a4500000-0000-0000-0000-0000000000bb"}';
DO $$
DECLARE v jsonb; ids text;
BEGIN
    v := public.get_canteen_accounts('a4500000-0000-0000-0000-000000000001');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the parent was refused: %', v;
    END IF;
    -- Every row that carries an id carries HIS id — not 4503's deposit, though
    -- 4503 is called "Mine" now and the invite still says "Mine".
    SELECT string_agg(DISTINCT t->>'camperId', ',') INTO ids
      FROM jsonb_array_elements(v->'transactions') t WHERE t->>'camperId' IS NOT NULL;
    IF ids IS DISTINCT FROM '4501' THEN
        RAISE EXCEPTION 'the parent should see only 4501''s rows, saw ids %: %', ids, v->'transactions';
    END IF;
    -- All three of his, whatever their age (a parent's view is not windowed).
    IF (SELECT count(*) FROM jsonb_array_elements(v->'transactions') t WHERE t->>'camperId' = '4501') <> 3 THEN
        RAISE EXCEPTION 'the parent''s own child''s history is incomplete: %', v->'transactions';
    END IF;
    -- A row with NO id is matched only by the name it was written under — the
    -- rule the accounts use. The invite now says "Mine Renamed", and "Mine" is
    -- another child, so the document's pre-id row under "Mine" is not shown.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'transactions') t WHERE t->>'camperId' IS NULL) THEN
        RAISE EXCEPTION 'a no-id row under a name that is no longer on his invite was shown: %', v->'transactions';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(v->'accounts') a WHERE a.value->>'camperId' IS DISTINCT FROM '4501') THEN
        RAISE EXCEPTION 'the parent can see an account that is not their child''s: %', v->'accounts';
    END IF;
END $$;


DO $$
DECLARE v jsonb := public.verify_canteen_ledger_reader();
BEGIN
    IF v IS DISTINCT FROM '{"reads_the_rows":true,"reads_the_document":false,"parent_matched_by_id":true}'::jsonb THEN
        RAISE EXCEPTION 'verifier: %', v;
    END IF;
END $$;

ROLLBACK;
