-- Behaviour test for migration 283 (TED-159): a register sale is charged once.
--   1. The same sale sent twice (a second tap, or a retry after a lost answer)
--      is charged once; the repeat gets the first answer, marked replayed.
--   2. A new sale (a new key) is charged as usual.
--   3. The key sent again for a different child or amount is refused.
--   4. A refused sale (not enough money) is not remembered — nothing charged.
--   5. Not for strangers; the checking script's 283 row says ok.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

INSERT INTO auth.users (id, email) VALUES
    ('f2830000-0000-0000-0000-0000000000aa', 'owner@283.test'),
    ('f2830000-0000-0000-0000-0000000000cc', 'register@283.test'),
    ('f2830000-0000-0000-0000-0000000000dd', 'stranger@283.test');
INSERT INTO camps (id, name, owner) VALUES ('f2830000-0000-0000-0000-000000000001', '283 camp', 'f2830000-0000-0000-0000-0000000000aa');
INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES
    ('f2830000-0000-0000-0000-000000000001', 'f2830000-0000-0000-0000-0000000000cc', 'counselor', now());
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('f2830000-0000-0000-0000-000000000001', 8301, 'camper', 'Avi', 'Avi'),
    ('f2830000-0000-0000-0000-000000000001', 8302, 'camper', 'Bina', 'Bina');

SET "request.jwt.claims" = '{"sub":"f2830000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('f2830000-0000-0000-0000-000000000001', 'Avi', 10);
SELECT public.canteen_office_credit('f2830000-0000-0000-0000-000000000001', 'Bina', 10);

SET "request.jwt.claims" = '{"sub":"f2830000-0000-0000-0000-0000000000cc"}';
DO $$
DECLARE
    c  uuid := 'f2830000-0000-0000-0000-000000000001';
    r  jsonb;
    bal numeric;
    n  int;
BEGIN
    -- 1. one sale, sent twice
    r := public.submit_canteen_purchase_once(c, 'sale_1', 'Avi', 2.50, 'Chips', NULL, 8301);
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'balance')::numeric <> 7.50 THEN RAISE EXCEPTION 'first: %', r; END IF;
    r := public.submit_canteen_purchase_once(c, 'sale_1', 'Avi', 2.50, 'Chips', NULL, 8301);
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'replayed')::boolean IS NOT TRUE OR (r->>'balance')::numeric <> 7.50 THEN
        RAISE EXCEPTION 'the repeat: %', r;
    END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8301;
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND camper = 'Avi' AND tx_type = 'debit';
    IF bal <> 7.50 OR n <> 1 THEN RAISE EXCEPTION 'TED-159: one sale charged % time(s), balance %', n, bal; END IF;

    -- 2. a new sale
    r := public.submit_canteen_purchase_once(c, 'sale_2', 'Avi', 2.50, 'Chips', NULL, 8301);
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8301;
    IF bal <> 5.00 THEN RAISE EXCEPTION 'a second, real sale was not charged: %', bal; END IF;

    -- 3. the same key for another child, or another amount
    r := public.submit_canteen_purchase_once(c, 'sale_1', 'Bina', 2.50, 'Chips', NULL, 8302);
    IF r->>'error' IS DISTINCT FROM 'sale_key_reused' THEN RAISE EXCEPTION 'key reused for another child: %', r; END IF;
    r := public.submit_canteen_purchase_once(c, 'sale_1', 'Avi', 4.00, 'Chips', NULL, 8301);
    IF r->>'error' IS DISTINCT FROM 'sale_key_reused' THEN RAISE EXCEPTION 'key reused for another amount: %', r; END IF;
    SELECT balance INTO bal FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8302;
    IF bal <> 10 THEN RAISE EXCEPTION 'Bina was charged on Avi''s key: %', bal; END IF;

    -- 4. refused: not remembered, so it can be tried again once there is money
    r := public.submit_canteen_purchase_once(c, 'sale_3', 'Bina', 50, 'Hoodie', NULL, 8302);
    IF (r->>'success')::boolean IS NOT FALSE OR r->>'error' NOT IN ('insufficient_balance', 'daily_limit_exceeded') THEN
        RAISE EXCEPTION 'over the limits: %', r;
    END IF;
    IF EXISTS (SELECT 1 FROM canteen_sale_keys WHERE camp_id = c AND sale_key = 'sale_3') THEN
        RAISE EXCEPTION 'a refused sale was remembered';
    END IF;

    -- no key: the plain charge, as before
    r := public.submit_canteen_purchase_once(c, NULL, 'Bina', 1, 'Gum', NULL, 8302);
    IF (r->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'no key: %', r; END IF;
END $$;

-- 5. strangers, and the grants
SET "request.jwt.claims" = '{"sub":"f2830000-0000-0000-0000-0000000000dd"}';
DO $$
DECLARE r jsonb;
BEGIN
    r := public.submit_canteen_purchase_once('f2830000-0000-0000-0000-000000000001', 'sale_x', 'Avi', 1, 'x', NULL, 8301);
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'a stranger charged a child: %', r; END IF;
    IF EXISTS (SELECT 1 FROM canteen_sale_keys WHERE sale_key = 'sale_x') THEN RAISE EXCEPTION 'a stranger left a key'; END IF;
    IF has_function_privilege('anon', 'public.submit_canteen_purchase_once(uuid,text,text,numeric,text,date,bigint)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anyone can charge';
    END IF;
    IF has_table_privilege('authenticated', 'public.canteen_sale_keys', 'SELECT') THEN
        RAISE EXCEPTION 'a browser can read the sale keys';
    END IF;
    RAISE NOTICE 'ok  283: one sale charged once / new sale charged / reused key refused / refusal not remembered / staff only';
END $$;
RESET "request.jwt.claims";

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v283 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v283 WHERE item LIKE '283%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 283 row says: %', r; END IF;
END $$;
ROLLBACK;
