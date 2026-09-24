-- Behaviour test for migration 288 (TED-186): while a family's payment is
-- charged back, autopay does not charge them again.
--   1. The chargeback marks every autopay plan of Teal's (not a plan without
--      autopay); a second mark changes nothing; one notice.
--   2. An old office tab saving Teal cannot take the mark off (266's merge).
--   3. The camp wins: that dispute's mark comes off; another dispute's stays.
--   4. After a loss the office resumes it — someone who can edit Billing only.
--   5. The webhook's functions are not for browsers; the checking script's 288
--      row says ok.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2880000-0000-0000-0000-0000000000a1', 'o@288.test'), ('f2880000-0000-0000-0000-0000000000b1', 'x@288.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2880000-0000-0000-0000-000000000001', 'f2880000-0000-0000-0000-0000000000a1', 'Dispute Camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2880000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'teal', jsonb_build_object('name', 'Teal', 'camperIds', jsonb_build_array('Ari Teal'),
     'plans', jsonb_build_array(
        jsonb_build_object('id', 'p1', 'autopay', true, 'dueDates', jsonb_build_array('2026-07-01')),
        jsonb_build_object('id', 'p2', 'autopay', false, 'dueDates', jsonb_build_array('2026-08-01')))))));

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT NULLIF(current_setting('t288.uid', true), '')::uuid $f$;
SELECT set_config('t288.uid', 'f2880000-0000-0000-0000-0000000000a1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2880000-0000-0000-0000-0000000000a1"}', false);
CREATE TEMP TABLE stale AS SELECT public.camp_family('f2880000-0000-0000-0000-000000000001', 'teal') AS copy;

DO $$
DECLARE c uuid := 'f2880000-0000-0000-0000-000000000001'; r jsonb; f jsonb; n int;
BEGIN
    -- 1. the chargeback
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_1', true, 'fraudulent');
    IF (r->>'changed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'hold: %', r; END IF;
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_1', true, 'fraudulent');
    IF (r->>'changed')::boolean THEN RAISE EXCEPTION 'marked twice: %', r; END IF;
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback'
       OR f->'plans'->0->'collectionBlocked'->>'disputeId' IS DISTINCT FROM 'dp_1' THEN
        RAISE EXCEPTION 'TED-186: the autopay plan was not paused: %', f->'plans';
    END IF;
    IF f->'plans'->1 ? 'collectionBlocked' THEN RAISE EXCEPTION 'a plan without autopay was marked'; END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'autopay_blocked';
    IF n <> 1 THEN RAISE EXCEPTION 'notices: %', n; END IF;

    -- 2. an old tab saves Teal
    r := public.sync_camp_billing(c, jsonb_build_object('teal', (SELECT copy FROM stale) || '{"note":"x"}'::jsonb), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback' THEN
        RAISE EXCEPTION 'an old tab took the pause off: %', f->'plans';
    END IF;

    -- 3. won — only that dispute's mark comes off
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_other', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked' IS NULL THEN RAISE EXCEPTION 'another dispute took the pause off'; END IF;
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_1', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0 ? 'collectionBlocked' THEN RAISE EXCEPTION 'won: still paused: %', f->'plans'; END IF;

    -- 4. lost: paused again, and the office resumes it
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_2', true, NULL);
    r := public.resume_autopay_after_dispute(c, 'teal');
    f := public.camp_family(c, 'teal');
    IF (r->>'success')::boolean IS NOT TRUE OR f->'plans'->0 ? 'collectionBlocked' THEN RAISE EXCEPTION 'resume: % / %', r, f->'plans'; END IF;

    -- 5. grants
    IF has_function_privilege('authenticated', 'public.hold_autopay_for_dispute(uuid,text,text,boolean,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can pause or resume autopay by dispute';
    END IF;
    RAISE NOTICE 'ok  288: a chargeback pauses autopay; stale tabs keep it; won resumes; the office resumes after a loss';
END $$;

-- a stranger cannot resume
SELECT set_config('t288.uid', 'f2880000-0000-0000-0000-0000000000b1', false);
DO $$
DECLARE r jsonb;
BEGIN
    PERFORM public.hold_autopay_for_dispute('f2880000-0000-0000-0000-000000000001', 'teal', 'dp_3', true, NULL);
    r := public.resume_autopay_after_dispute('f2880000-0000-0000-0000-000000000001', 'teal');
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'a stranger resumed autopay: %', r; END IF;
END $$;
SELECT set_config('t288.uid', 'f2880000-0000-0000-0000-0000000000a1', false);

\i migrations/288_autopay_waits_while_a_payment_is_disputed.sql

\set verify_q `cat scripts/verify_identity_chain.sql`
BEGIN;
CREATE TEMP TABLE v288 AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v288 WHERE item LIKE '288%';
    IF r IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'the checking script''s 288 row says: %', r; END IF;
END $$;
ROLLBACK;
