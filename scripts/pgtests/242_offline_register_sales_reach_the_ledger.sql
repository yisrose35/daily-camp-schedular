-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 242: offline-register sales reach the ledger.
--
--   1. a stranger cannot import into another camp
--   2. the owner's import moves the balance and writes the ledger row
--   3. the same file again moves nothing (idempotent on the register's sale id)
--   4. a camper renamed between export and import is charged on THEIR account
--   5. today's offline sales count toward today's cap; older ones do not
--   6. a bad row is refused on its own, and the good rows around it still land
--   7. the verifier reports the shape
--
-- uuids are prefixed a4200000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a4200000-0000-0000-0000-0000000000aa', 'owner@242.test'),
    ('a4200000-0000-0000-0000-0000000000bb', 'stranger@242.test');

INSERT INTO camps (id, name, owner)
VALUES ('a4200000-0000-0000-0000-000000000001', '242 camp',
        'a4200000-0000-0000-0000-0000000000aa');

INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4200000-0000-0000-0000-000000000001', 4201, 'camper', 'Kid A', 'Kid A'),
    ('a4200000-0000-0000-0000-000000000001', 4202, 'camper', 'Kid B', 'Kid B');

SET "request.jwt.claims" = '{"sub":"a4200000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_account_save('a4200000-0000-0000-0000-000000000001'::uuid, 'Kid A',
    '{"balance":50,"dailyLimit":10,"spentToday":4,"lastSpendDate":"2026-07-10"}'::jsonb);
SELECT public.canteen_account_save('a4200000-0000-0000-0000-000000000001'::uuid, 'Kid B',
    '{"balance":20,"dailyLimit":10,"spentToday":0}'::jsonb);

CREATE OR REPLACE FUNCTION pg_temp.balance_of(k text) RETURNS numeric LANGUAGE sql AS $f$
    SELECT balance FROM camp_canteen_accounts
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND account_key = k
$f$;


-- ─── 1. a stranger is refused, and nothing moves ────────────────────────────
SET "request.jwt.claims" = '{"sub":"a4200000-0000-0000-0000-0000000000bb"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"id":"s1","camper":"Kid A","camperId":4201,"amount":3,"type":"debit","date":"2026-07-10"}]');
    IF v->>'error' IS DISTINCT FROM 'not_authorized' THEN
        RAISE EXCEPTION 'a stranger was not refused: %', v;
    END IF;
    IF pg_temp.balance_of('Kid A') <> 50 THEN
        RAISE EXCEPTION 'a refused import moved the balance to %', pg_temp.balance_of('Kid A');
    END IF;
END $$;


-- ─── 2. the owner's import lands: balance and ledger ────────────────────────
SET "request.jwt.claims" = '{"sub":"a4200000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb; n int;
BEGIN
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"id":"s1","camper":"Kid A","camperId":4201,"amount":3,"type":"debit","date":"2026-07-10","items":"Chips","time":"2:00 PM"},
          {"id":"s2","camper":"Kid A","camperId":4201,"amount":2.5,"type":"debit","date":"2026-07-10","items":"Soda"}]');
    IF (v->>'imported')::int IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'expected 2 imported: %', v;
    END IF;
    IF pg_temp.balance_of('Kid A') <> 44.50 THEN
        RAISE EXCEPTION 'expected 44.50 after $5.50 of offline sales, got %', pg_temp.balance_of('Kid A');
    END IF;
    SELECT count(*) INTO n FROM canteen_transactions
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND sig LIKE 'offline:%'
       AND camper_id = '4201' AND tx_type = 'debit';
    IF n <> 2 THEN
        RAISE EXCEPTION 'expected 2 ledger rows carrying camper id 4201, found %', n;
    END IF;
END $$;


-- ─── 3. the same file again moves nothing ───────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"id":"s1","camper":"Kid A","camperId":4201,"amount":3,"type":"debit","date":"2026-07-10"},
          {"id":"s2","camper":"Kid A","camperId":4201,"amount":2.5,"type":"debit","date":"2026-07-10"}]');
    IF (v->>'imported')::int <> 0 OR (v->>'duplicates')::int <> 2 THEN
        RAISE EXCEPTION 'a re-import was not recognised as duplicates: %', v;
    END IF;
    IF pg_temp.balance_of('Kid A') <> 44.50 THEN
        RAISE EXCEPTION 're-importing moved the balance again, to %', pg_temp.balance_of('Kid A');
    END IF;
END $$;


-- ─── 4. renamed between export and import: the PERSON pays ──────────────────
-- The register still says "Kid B"; the roster now calls 4202 "Kid Bee". The id
-- wins, so no second account appears under the old spelling.
UPDATE camp_people SET name = 'Kid Bee', source_key = 'Kid Bee'
 WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND person_id = 4202;
-- And the old spelling now belongs to a DIFFERENT child, with money of their
-- own. A name-first import would charge them for somebody else's candy.
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name)
VALUES ('a4200000-0000-0000-0000-000000000001', 4203, 'camper', 'Kid B (new)', 'Kid B (new)');
SELECT public.canteen_account_save('a4200000-0000-0000-0000-000000000001'::uuid, 'Kid B (new)',
    '{"balance":30,"dailyLimit":10,"spentToday":0}'::jsonb);
UPDATE camp_people SET name = 'Kid B', source_key = 'Kid B'
 WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND person_id = 4203;
DO $$
DECLARE v jsonb; n int;
BEGIN
    IF public.camp_person_by_name('a4200000-0000-0000-0000-000000000001'::uuid, 'Kid B')
       IS DISTINCT FROM 4203 THEN
        RAISE EXCEPTION 'setup: "Kid B" should now resolve to the new child 4203';
    END IF;
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"id":"s3","camper":"Kid B","camperId":4202,"amount":4,"type":"debit","date":"2026-07-10"}]');
    IF (v->>'imported')::int <> 1 THEN
        RAISE EXCEPTION 'the renamed camper''s sale did not import: %', v;
    END IF;
    SELECT count(*) INTO n FROM camp_canteen_accounts
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND person_id = 4202;
    IF n <> 1 THEN
        RAISE EXCEPTION 'person 4202 has % accounts — the rename opened a second one', n;
    END IF;
    SELECT count(*) INTO n FROM camp_canteen_accounts
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001'
       AND person_id = 4202 AND balance = 16;
    IF n <> 1 THEN
        RAISE EXCEPTION 'person 4202 was not charged $4 on their own account: %',
            (SELECT jsonb_agg(to_jsonb(a)) FROM camp_canteen_accounts a
              WHERE camp_id = 'a4200000-0000-0000-0000-000000000001');
    END IF;
    SELECT count(*) INTO n FROM camp_canteen_accounts
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001'
       AND person_id = 4203 AND balance = 30;
    IF n <> 1 THEN
        RAISE EXCEPTION 'the child who now carries the old name was charged: %',
            (SELECT jsonb_agg(to_jsonb(a)) FROM camp_canteen_accounts a
              WHERE camp_id = 'a4200000-0000-0000-0000-000000000001');
    END IF;
END $$;


-- ─── 5. the cap knows about today's offline sales, not yesterday's ──────────
DO $$
DECLARE v jsonb; a jsonb;
BEGIN
    -- Kid A already had spentToday 4 on 2026-07-10, and section 2 added 5.50.
    SELECT to_jsonb(x) INTO a FROM camp_canteen_accounts x
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND account_key = 'Kid A';
    IF (a->>'spent_today')::numeric IS DISTINCT FROM 9.50
       AND (a->'data'->>'spentToday')::numeric IS DISTINCT FROM 9.50 THEN
        RAISE EXCEPTION 'same-day offline sales did not count toward the cap: %', a;
    END IF;

    -- An older day's sale is history: it moves the balance, not today's counter.
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"id":"s4","camper":"Kid A","camperId":4201,"amount":1,"type":"debit","date":"2026-07-09"}]');
    SELECT to_jsonb(x) INTO a FROM camp_canteen_accounts x
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND account_key = 'Kid A';
    IF (a->>'spent_today')::numeric IS DISTINCT FROM 9.50
       AND (a->'data'->>'spentToday')::numeric IS DISTINCT FROM 9.50 THEN
        RAISE EXCEPTION 'yesterday''s sale moved today''s counter: %', a;
    END IF;
    IF pg_temp.balance_of('Kid A') <> 43.50 THEN
        RAISE EXCEPTION 'yesterday''s sale did not move the balance: %', pg_temp.balance_of('Kid A');
    END IF;

    -- A later day's sale starts that day's counter afresh.
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"id":"s5","camper":"Kid A","camperId":4201,"amount":2,"type":"debit","date":"2026-07-11"}]');
    SELECT to_jsonb(x) INTO a FROM camp_canteen_accounts x
     WHERE camp_id = 'a4200000-0000-0000-0000-000000000001' AND account_key = 'Kid A';
    IF (a->>'spent_today')::numeric IS DISTINCT FROM 2
       AND (a->'data'->>'spentToday')::numeric IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'a new day did not reset the counter to that day''s sales: %', a;
    END IF;
END $$;


-- ─── 6. a bad row is refused alone ──────────────────────────────────────────
DO $$
DECLARE v jsonb; codes text;
BEGIN
    v := public.canteen_office_import_offline('a4200000-0000-0000-0000-000000000001'::uuid,
        '[{"camper":"Kid A","amount":1,"type":"debit","date":"2026-07-11"},
          {"id":"b2","camper":"Kid A","amount":1,"type":"credit","date":"2026-07-11"},
          {"id":"b3","camper":"Kid A","amount":-5,"type":"debit","date":"2026-07-11"},
          {"id":"b4","camper":"Kid A","amount":1,"type":"debit","date":"yesterday"},
          {"id":"b5","camper":"Ghost","camperId":999999,"amount":1,"type":"debit","date":"2026-07-11"},
          {"id":"g1","camper":"Kid A","camperId":4201,"amount":1,"type":"debit","date":"2026-07-11"}]');
    SELECT string_agg(e->>'error', ',' ORDER BY e->>'error') INTO codes
      FROM jsonb_array_elements(v->'refused') e;
    IF codes IS DISTINCT FROM 'invalid_amount,invalid_date,missing_id,unknown_camper,unsupported_type' THEN
        RAISE EXCEPTION 'unexpected refusals: % (%)', codes, v;
    END IF;
    IF (v->>'imported')::int <> 1 THEN
        RAISE EXCEPTION 'the good row did not land beside the bad ones: %', v;
    END IF;
    IF pg_temp.balance_of('Kid A') <> 40.50 THEN
        RAISE EXCEPTION 'expected 40.50, got %', pg_temp.balance_of('Kid A');
    END IF;
END $$;


-- ─── 7. the verifier ────────────────────────────────────────────────────────
DO $$
DECLARE v jsonb := public.verify_offline_import();
BEGIN
    IF v IS DISTINCT FROM '{"present":true,"gated":true,"idempotent_by_sig":true,"resolves_by_id":true}'::jsonb THEN
        RAISE EXCEPTION 'verifier: %', v;
    END IF;
END $$;

ROLLBACK;
