-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 246: a parent's balance counts what they have paid.
--
-- $1,000 tuition, $400 paid (a camp_payments row). The derived balance's
-- DOCUMENT path — the one taken when the projection stamp does not match —
-- read payments from me->'finance'->'payments', gone since 158, and answered
-- $1,000 owing. It must answer $600, and so must the projection path.
--
-- uuids are prefixed a4600000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a4600000-0000-0000-0000-0000000000aa', 'owner@246.test'),
    ('a4600000-0000-0000-0000-0000000000bb', 'parent@246.test');
INSERT INTO camps (id, name, owner)
VALUES ('a4600000-0000-0000-0000-000000000001', '246 camp', 'a4600000-0000-0000-0000-0000000000aa');

INSERT INTO camp_state_kv (camp_id, key, value) VALUES
 ('a4600000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'sessions',    jsonb_build_array(jsonb_build_object('name', 'Full Summer', 'tuition', 1000)),
    'enrollments', jsonb_build_object('e1', jsonb_build_object(
                       'camperName', 'Kid', 'status', 'enrolled',
                       'session', 'Full Summer', 'sessionTuition', 1000)),
    'families',    jsonb_build_object('fam1', jsonb_build_object(
                       'name', 'Family', 'camperIds', jsonb_build_array('Kid')))));

-- The families branch reaches its row through the projection; make sure it did.
DO $$
BEGIN
    IF public.camp_family('a4600000-0000-0000-0000-000000000001', 'fam1') IS NULL THEN
        RAISE EXCEPTION 'setup: the family row was not projected';
    END IF;
END $$;

-- What they paid: a payment ROW, the way sync_camp_billing and every webhook write it.
INSERT INTO camp_payments (camp_id, payment_id, family_name, family_key, status, amount, pay_date, payload)
VALUES ('a4600000-0000-0000-0000-000000000001', 'pay-1', 'Family', 'fam1', 'succeeded', 400, '2026-06-01',
        '{"id":"pay-1","family":"Family","familyKey":"fam1","amount":400,"status":"succeeded","date":"2026-06-01"}');

INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status)
VALUES ('a4600000-0000-0000-0000-000000000001', 'a4600000-0000-0000-0000-0000000000bb',
        'parent@246.test', '["Kid"]', 'active');


SET "request.jwt.claims" = '{"sub":"a4600000-0000-0000-0000-0000000000bb"}';

-- ─── 1. the document path ───────────────────────────────────────────────────
-- Force it: the projection stamp no longer matches the document's.
UPDATE camp_billing_config SET blob_updated_at = blob_updated_at - interval '1 day'
 WHERE camp_id = 'a4600000-0000-0000-0000-000000000001';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_my_balance_derived('a4600000-0000-0000-0000-000000000001');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN
        RAISE EXCEPTION 'the parent''s balance failed: %', v;
    END IF;
    IF (v->>'paid')::numeric IS DISTINCT FROM 400 OR (v->>'balance')::numeric IS DISTINCT FROM 600 THEN
        RAISE EXCEPTION 'document path: expected paid 400 / balance 600, got paid % / balance %',
            v->>'paid', v->>'balance';
    END IF;
END $$;

-- ─── 2. the projection path agrees ──────────────────────────────────────────
UPDATE camp_billing_config c SET blob_updated_at = k.updated_at
  FROM camp_state_kv k
 WHERE c.camp_id = 'a4600000-0000-0000-0000-000000000001'
   AND k.camp_id = c.camp_id AND k.key = 'campistryMe';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_my_balance_derived('a4600000-0000-0000-0000-000000000001');
    IF (v->>'balance')::numeric IS DISTINCT FROM 600 THEN
        RAISE EXCEPTION 'projection path: expected balance 600, got %', v->>'balance';
    END IF;
END $$;

-- ─── 3. nothing left reads the dead branch ──────────────────────────────────
DO $$
DECLARE v jsonb := public.verify_no_finance_payments_readers();
BEGIN
    IF v->'still_reading_finance_payments' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'still reading me->finance->payments: %', v;
    END IF;
END $$;

ROLLBACK;
