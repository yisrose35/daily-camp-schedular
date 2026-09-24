-- Behaviour test for migration 284 (TED-175): a register sale made by mistake
-- is voided — not given back as a deposit.
--   1. Avi is charged $5 for two ices by mistake. The office voids that sale:
--      $5 back on the balance and off today's spending, one 'void' line that
--      names the sale (a credit with no payment method), the two ices back in
--      stock and off "sold".
--   2. The same sale again: refused, nothing moves.
--   3. A sale from an earlier day comes back on the balance, but today's
--      spending is left alone.
--   4. Not a deposit, not a Shop order, not a sale this camp does not have.
--   5. Not for strangers or anonymous callers.
--   6. A child's history carries each row's sig, so any sale on screen can be
--      named; the checking script's 284 row says ok.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

INSERT INTO auth.users (id, email) VALUES
    ('f2840000-0000-0000-0000-0000000000aa', 'owner@284.test'),
    ('f2840000-0000-0000-0000-0000000000cc', 'register@284.test'),
    ('f2840000-0000-0000-0000-0000000000dd', 'stranger@284.test');
INSERT INTO camps (id, name, owner) VALUES ('f2840000-0000-0000-0000-000000000001', '284 camp', 'f2840000-0000-0000-0000-0000000000aa');
INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES
    ('f2840000-0000-0000-0000-000000000001', 'f2840000-0000-0000-0000-0000000000cc', 'counselor', now());
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('f2840000-0000-0000-0000-000000000001', 8401, 'camper', 'Avi', 'Avi'),
    ('f2840000-0000-0000-0000-000000000001', 8402, 'camper', 'Bina', 'Bina');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2840000-0000-0000-0000-000000000001', 'campistrySnacks',
    '{"inventory":[{"id":1,"name":"Ices","price":2.5,"stock":10,"soldToday":2,"totalSold":5},{"id":2,"name":"Chips","price":1,"stock":null,"soldToday":0,"totalSold":0}]}'::jsonb);

SET "request.jwt.claims" = '{"sub":"f2840000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('f2840000-0000-0000-0000-000000000001', 'Avi', 10);
SELECT public.canteen_office_credit('f2840000-0000-0000-0000-000000000001', 'Bina', 10);

-- the register's sales
SET "request.jwt.claims" = '{"sub":"f2840000-0000-0000-0000-0000000000cc"}';
SELECT public.submit_canteen_purchase_once('f2840000-0000-0000-0000-000000000001', 'k1', 'Avi', 5, 'Ices ×2', NULL, 8401);
SELECT public.submit_canteen_purchase('f2840000-0000-0000-0000-000000000001', 'Bina', 2, 'Chips ×2', ((now() AT TIME ZONE 'utc')::date - 1), 8402);
SELECT public.submit_canteen_purchase('f2840000-0000-0000-0000-000000000001', 'Bina', 1, 'Chips', NULL, 8402);

SET "request.jwt.claims" = '{"sub":"f2840000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE
    c    uuid := 'f2840000-0000-0000-0000-000000000001';
    r    jsonb;
    s    text;
    acct camp_canteen_accounts%ROWTYPE;
    v    canteen_transactions%ROWTYPE;
    inv  jsonb;
    n    int;
BEGIN
    SELECT sig INTO s FROM canteen_transactions WHERE camp_id = c AND camper_id = '8401' AND tx_type = 'debit';
    SELECT * INTO acct FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8401;
    IF acct.balance <> 5 THEN RAISE EXCEPTION 'setup: Avi should have $5 left, has %', acct.balance; END IF;

    -- 1. the void
    r := public.canteen_void_sale(c, s, '[{"id":1,"qty":2}]'::jsonb, 'wrong child');
    IF (r->>'success')::boolean IS NOT TRUE OR (r->>'balance')::numeric <> 10 OR (r->>'amount')::numeric <> 5
       OR (r->>'restocked')::int <> 2 THEN
        RAISE EXCEPTION 'the void: %', r;
    END IF;
    SELECT * INTO acct FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8401;
    IF acct.balance <> 10 OR COALESCE((acct.payload->>'spentToday')::numeric, 0) <> 0 THEN
        RAISE EXCEPTION 'TED-175: after the void Avi should have $10 and $0 spent today: % / %', acct.balance, acct.payload;
    END IF;
    SELECT * INTO v FROM canteen_transactions WHERE camp_id = c AND sig = 'void:' || s;
    IF NOT FOUND OR v.tx_type <> 'credit' OR v.amount <> 5 OR v.payload->>'kind' <> 'void'
       OR v.payload->>'voidOf' <> s OR v.camper_id IS DISTINCT FROM '8401' OR v.payload ? 'method' THEN
        RAISE EXCEPTION 'TED-175: the void line (a reversal of the sale, not a deposit): %', to_jsonb(v);
    END IF;
    SELECT value->'inventory' INTO inv FROM camp_state_kv WHERE camp_id = c AND key = 'campistrySnacks';
    IF (inv->0->>'stock')::numeric <> 12 OR (inv->0->>'soldToday')::numeric <> 0 OR (inv->0->>'totalSold')::numeric <> 3
       OR inv->1->'stock' <> 'null'::jsonb THEN
        RAISE EXCEPTION 'TED-175: the ices back in stock: %', inv;
    END IF;

    -- 2. again: refused, nothing moves
    r := public.canteen_void_sale(c, s, '[{"id":1,"qty":2}]'::jsonb, NULL);
    IF r->>'error' IS DISTINCT FROM 'already_voided' THEN RAISE EXCEPTION 'voided twice: %', r; END IF;
    SELECT * INTO acct FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8401;
    SELECT value->'inventory' INTO inv FROM camp_state_kv WHERE camp_id = c AND key = 'campistrySnacks';
    SELECT count(*) INTO n FROM canteen_transactions WHERE camp_id = c AND payload->>'kind' = 'void';
    IF acct.balance <> 10 OR (inv->0->>'stock')::numeric <> 12 OR n <> 1 THEN
        RAISE EXCEPTION 'the second void moved something: balance %, stock %, % void lines', acct.balance, inv->0->>'stock', n;
    END IF;

    -- 3. yesterday's sale: the balance, not today's spending
    SELECT sig INTO s FROM canteen_transactions WHERE camp_id = c AND camper_id = '8402' AND tx_type = 'debit' AND amount = 2;
    r := public.canteen_void_sale(c, s, '[]'::jsonb, NULL);
    SELECT * INTO acct FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 8402;
    IF (r->>'success')::boolean IS NOT TRUE OR acct.balance <> 9 OR (acct.payload->>'spentToday')::numeric <> 1 THEN
        RAISE EXCEPTION 'an earlier day''s sale: % — balance %, spent today %', r, acct.balance, acct.payload->>'spentToday';
    END IF;

    -- 4. not a deposit, not a Shop order, not another camp's
    SELECT sig INTO s FROM canteen_transactions WHERE camp_id = c AND camper_id = '8402' AND tx_type = 'credit' AND payload->>'kind' IS DISTINCT FROM 'void' LIMIT 1;
    r := public.canteen_void_sale(c, s, '[]'::jsonb, NULL);
    IF r->>'error' IS DISTINCT FROM 'not_a_sale' THEN RAISE EXCEPTION 'a deposit was voided: %', r; END IF;
    PERFORM public.canteen_post(c, 'Bina', jsonb_build_object('type', 'debit', 'kind', 'shop', 'amount', 12,
        'items', 'Hoodie', 'date', (now() AT TIME ZONE 'utc')::date::text, 'time', '10:00 AM'), 'shop:t284');
    r := public.canteen_void_sale(c, 'shop:t284', '[]'::jsonb, NULL);
    IF r->>'error' IS DISTINCT FROM 'not_a_sale' OR r->>'message' NOT LIKE '%refund it from the Shop%' THEN
        RAISE EXCEPTION 'a Shop order: %', r;
    END IF;
    r := public.canteen_void_sale(c, 'no-such-sale', '[]'::jsonb, NULL);
    IF r->>'error' IS DISTINCT FROM 'sale_not_found' THEN RAISE EXCEPTION 'an unknown sale: %', r; END IF;
    r := public.canteen_void_sale('f2840000-0000-0000-0000-00000000ffff', s, '[]'::jsonb, NULL);
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'another camp: %', r; END IF;

    -- 6. the history carries sigs
    r := public.get_canteen_history(c, 'Avi', NULL, 50);
    SELECT count(*) INTO n FROM jsonb_array_elements(r->'transactions') x WHERE NULLIF(x->>'sig', '') IS NULL;
    IF (r->>'success')::boolean IS NOT TRUE OR jsonb_array_length(r->'transactions') < 3 OR n <> 0 THEN
        RAISE EXCEPTION 'history rows without their sig: %', r;
    END IF;
    RAISE NOTICE 'ok  284: void once, money and stock back, not a deposit / refusals / history carries sigs';
END $$;

-- 5. strangers
SET "request.jwt.claims" = '{"sub":"f2840000-0000-0000-0000-0000000000dd"}';
DO $$
DECLARE r jsonb; s text;
BEGIN
    SELECT sig INTO s FROM canteen_transactions WHERE camp_id = 'f2840000-0000-0000-0000-000000000001' AND tx_type = 'debit' AND amount = 1;
    r := public.canteen_void_sale('f2840000-0000-0000-0000-000000000001', s, '[]'::jsonb, NULL);
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'a stranger voided a sale: %', r; END IF;
    IF has_function_privilege('anon', 'public.canteen_void_sale(uuid,text,jsonb,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anonymous callers can void sales';
    END IF;
END $$;
RESET "request.jwt.claims";

-- safe to run again (the history patch sees it is already in)
\i migrations/284_a_register_sale_can_be_voided.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v284 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v284 WHERE item LIKE '284%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 284 row says: %', r; END IF;
END $$;
ROLLBACK;
