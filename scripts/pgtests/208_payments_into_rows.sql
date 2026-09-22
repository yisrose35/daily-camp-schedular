-- Behaviour test for migration 208, run by scripts/try_migration.sh against a
-- throwaway Postgres AFTER the migration itself. Every check RAISEs on failure,
-- so a clean run means every assertion held.
\set ON_ERROR_STOP on

-- ── fixture: one camp, three payments, one of them a duplicate identity ────
INSERT INTO public.camps (id, owner, name)
VALUES ('11111111-1111-1111-1111-111111111111', NULL, 'Test Camp');

INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('11111111-1111-1111-1111-111111111111', 'campistryMe', jsonb_build_object(
  'finance', jsonb_build_object('payments', jsonb_build_array(
     jsonb_build_object('id','p1','family','Cohen','familyKey','fk1','amount',100,'status','','date','2026-07-01','method','card'),
     jsonb_build_object('id','p2','family','Levy','familyKey','fk2','amount',250.50,'status','pending','date','2026-07-02','method','ach'),
     -- no id at all: must fall back to the deterministic signature
     jsonb_build_object('family','Stern','familyKey','fk3','amount',75,'status','','date','2026-07-03','method','cash'),
     -- SAME identity as p1, later in the array: payload must come from here
     jsonb_build_object('id','p1','family','Cohen','familyKey','fk1','amount',120,'status','','date','2026-07-01','method','card')
  ))));

-- The trigger fired on that INSERT. Prove it, before the backfill runs at all.
DO $$
DECLARE n integer; v numeric;
BEGIN
    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 3 THEN RAISE EXCEPTION 'trigger on INSERT: expected 3 distinct identities, got %', n; END IF;

    SELECT amount INTO v FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND payment_id = 'p1';
    IF v <> 120 THEN RAISE EXCEPTION 'duplicate identity: LAST must win, got amount %', v; END IF;

    IF NOT EXISTS (SELECT 1 FROM camp_payments
                    WHERE camp_id = '11111111-1111-1111-1111-111111111111'
                      AND payment_id LIKE 'sig:%') THEN
        RAISE EXCEPTION 'an id-less payment did not get a signature identity';
    END IF;
    RAISE NOTICE 'ok  trigger on INSERT: 3 rows, last duplicate wins, signature fallback';
END $$;

-- ── the verifier must agree with the array ─────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    r := public.verify_camp_payments('11111111-1111-1111-1111-111111111111');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'verify says out of sync: %', r; END IF;
    IF (r ->> 'missingFromRows') <> '0' THEN RAISE EXCEPTION 'missingFromRows: %', r; END IF;
    IF (r ->> 'staleRows') <> '0' THEN RAISE EXCEPTION 'staleRows: %', r; END IF;
    -- collected excludes the pending 250.50; 120 (p1 last-wins) + 75 = 195
    IF (r ->> 'collectedInRows')::numeric <> 195 THEN
        RAISE EXCEPTION 'collectedInRows should be 195 (pending excluded), got %', r ->> 'collectedInRows';
    END IF;
    IF (r ->> 'collectedInBlob')::numeric <> (r ->> 'collectedInRows')::numeric THEN
        RAISE EXCEPTION 'the two sides disagree on collected money: %', r;
    END IF;
    RAISE NOTICE 'ok  verifier: inSync, collected 195 both sides, pending excluded';
END $$;

-- ── a status transition patches in place and does NOT reorder history ──────
DO $$
DECLARE v_ord_before bigint; v_ord_after bigint; v_status text; n integer;
BEGIN
    SELECT ordinal INTO v_ord_before FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND payment_id = 'p2';

    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{finance,payments,1,status}', '"succeeded"'::jsonb),
           updated_at = now()
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND key = 'campistryMe';

    SELECT ordinal, status INTO v_ord_after, v_status FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND payment_id = 'p2';
    IF v_status <> 'succeeded' THEN RAISE EXCEPTION 'patch not applied, status is %', v_status; END IF;
    IF v_ord_after <> v_ord_before THEN
        RAISE EXCEPTION 'ordinal moved on a status change: % -> %', v_ord_before, v_ord_after;
    END IF;
    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 3 THEN RAISE EXCEPTION 'a patch created a duplicate row: % rows', n; END IF;
    RAISE NOTICE 'ok  status transition patches in place, keeps its position, adds no row';
END $$;

-- ── a new payment appends one row ──────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{finance,payments}',
               (value -> 'finance' -> 'payments') || jsonb_build_array(
                   jsonb_build_object('id','p9','family','Adler','familyKey','fk9',
                                      'amount',40,'status','','date','2026-07-09','method','card'))),
           updated_at = now()
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND key = 'campistryMe';
    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 4 THEN RAISE EXCEPTION 'appending one payment should give 4 rows, got %', n; END IF;
    IF (public.verify_camp_payments('11111111-1111-1111-1111-111111111111') ->> 'inSync') <> 'true' THEN
        RAISE EXCEPTION 'out of sync after an append';
    END IF;
    RAISE NOTICE 'ok  a new payment appends one row and stays in sync';
END $$;

-- ── a save that does not touch payments must change nothing ────────────────
DO $$
DECLARE before_ts timestamptz; after_ts timestamptz;
BEGIN
    SELECT max(updated_at) INTO before_ts FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111';
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{campName}', '"Renamed"'::jsonb), updated_at = now()
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND key = 'campistryMe';
    SELECT max(updated_at) INTO after_ts FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111';
    IF after_ts IS DISTINCT FROM before_ts THEN
        RAISE EXCEPTION 'an unrelated save touched payment rows (% -> %)', before_ts, after_ts;
    END IF;
    RAISE NOTICE 'ok  an unrelated save costs one comparison and writes nothing';
END $$;

-- ── rows are NEVER deleted, even when the array shrinks ────────────────────
-- This is the append-only guarantee phase 2 depends on, and it is also what a
-- stale client save looks like: a shorter array than the server already knows.
DO $$
DECLARE n integer; r jsonb;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{finance,payments}', '[]'::jsonb), updated_at = now()
     WHERE camp_id = '11111111-1111-1111-1111-111111111111' AND key = 'campistryMe';
    SELECT count(*) INTO n FROM camp_payments
     WHERE camp_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 4 THEN RAISE EXCEPTION 'emptying the array deleted rows: % left of 4', n; END IF;
    r := public.verify_camp_payments('11111111-1111-1111-1111-111111111111');
    -- rowPayments now EXCEEDS blobPayments. That is expected, documented, and
    -- must NOT be reported as a failure.
    IF (r ->> 'missingFromRows') <> '0' OR (r ->> 'staleRows') <> '0' THEN
        RAISE EXCEPTION 'a shorter array must not create missing/stale: %', r;
    END IF;
    IF (r ->> 'rowPayments')::int <= (r ->> 'blobPayments')::int THEN
        RAISE EXCEPTION 'expected rows to outnumber the array here: %', r;
    END IF;
    RAISE NOTICE 'ok  append-only: a shortened array loses no rows, and is not a failure';
END $$;

-- ── the backfill is idempotent ─────────────────────────────────────────────
-- Restore the array, then re-run the migration's own backfill shape and prove
-- the row count does not move.
DO $$
DECLARE n1 integer; n2 integer;
BEGIN
    SELECT count(*) INTO n1 FROM camp_payments;
    INSERT INTO public.camp_payments
        (camp_id, payment_id, family_name, family_key, enrollment_id,
         status, amount, pay_date, payload)
    SELECT d.camp_id, d.pid,
           COALESCE(d.pay ->> 'family',''), COALESCE(d.pay ->> 'familyKey',''),
           COALESCE(d.pay ->> 'enrollmentId',''), COALESCE(d.pay ->> 'status',''),
           COALESCE(public._num_or_null(d.pay ->> 'amount'),0),
           COALESCE(d.pay ->> 'date',''), d.pay
      FROM (SELECT kv.camp_id, public.camp_payment_identity(p.value) AS pid,
                   min(p.ord) AS first_ord,
                   (array_agg(p.value ORDER BY p.ord DESC))[1] AS pay
              FROM camp_state_kv kv
              CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(kv.value -> 'finance' -> 'payments') = 'array'
                          THEN kv.value -> 'finance' -> 'payments' ELSE '[]'::jsonb END)
                   WITH ORDINALITY AS p(value, ord)
             WHERE kv.key = 'campistryMe' AND jsonb_typeof(p.value) = 'object'
               AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
             GROUP BY kv.camp_id, public.camp_payment_identity(p.value)) AS d
     ORDER BY d.camp_id, d.first_ord
    ON CONFLICT (camp_id, payment_id) DO NOTHING;
    SELECT count(*) INTO n2 FROM camp_payments;
    IF n1 <> n2 THEN RAISE EXCEPTION 'backfill is not idempotent: % -> %', n1, n2; END IF;
    RAISE NOTICE 'ok  the backfill converges instead of duplicating';
END $$;

-- ── a camp with no payments at all ─────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    INSERT INTO public.camps (id, owner, name)
    VALUES ('22222222-2222-2222-2222-222222222222', NULL, 'Empty Camp');
    INSERT INTO public.camp_state_kv (camp_id, key, value)
    VALUES ('22222222-2222-2222-2222-222222222222', 'campistryMe', '{}'::jsonb);
    r := public.verify_camp_payments('22222222-2222-2222-2222-222222222222');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'an empty camp should be in sync: %', r; END IF;
    IF (r ->> 'collectedInBlob')::numeric <> 0 THEN RAISE EXCEPTION 'empty camp collected <> 0: %', r; END IF;
    RAISE NOTICE 'ok  a camp with no payments verifies clean';
END $$;

-- ── malformed data must not abort a real save ──────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    -- NOTE: jsonb_set cannot create {finance,payments} when `finance` is absent,
    -- and this camp's document is {} — it would silently do nothing. Build the
    -- branch instead.
    UPDATE camp_state_kv
       SET value = value || jsonb_build_object('finance',
               jsonb_build_object('payments', jsonb_build_array(
                   jsonb_build_object('id','bad1','amount','not a number','status','','family','X'),
                   '"a bare string, not an object"'::jsonb,
                   jsonb_build_object('id','good1','amount',10,'status','','family','Y')))),
           updated_at = now()
     WHERE camp_id = '22222222-2222-2222-2222-222222222222' AND key = 'campistryMe';
    IF NOT EXISTS (SELECT 1 FROM camp_payments WHERE payment_id = 'good1') THEN
        RAISE EXCEPTION 'a malformed sibling stopped a good payment being recorded';
    END IF;
    IF (SELECT amount FROM camp_payments WHERE payment_id = 'bad1') <> 0 THEN
        RAISE EXCEPTION 'an unparseable amount should become 0, not abort';
    END IF;
    IF EXISTS (SELECT 1 FROM camp_payments WHERE payload = '"a bare string, not an object"'::jsonb) THEN
        RAISE EXCEPTION 'a non-object array entry should be skipped';
    END IF;
    RAISE NOTICE 'ok  malformed entries cost themselves, never the save';
END $$;

SELECT 'ALL 208 BEHAVIOUR CHECKS PASSED' AS result;
