-- Behaviour test for migration 288 (TED-186): while a family's payment is
-- charged back, autopay does not charge them again.
--   1. The chargeback pauses Teal — the family itself and every plan, autopay
--      on or not (TED-200); a second mark changes nothing; one notice. A
--      family with no plan (Fern) and one with the old single plan (Ash) are
--      paused too (TED-200/201).
--   2. An old office tab saving Teal cannot take the mark off (266's merge).
--   3. The camp wins: that dispute's mark comes off; another dispute's stays.
--   4. Resume is refused while a dispute is still open, and allowed once it is
--      lost (TED-202) — someone who can edit Billing only.
--   5. The webhook's functions are not for browsers; the checking script's 288
--      row says ok.
\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email) VALUES ('f2880000-0000-0000-0000-0000000000a1', 'o@288.test'), ('f2880000-0000-0000-0000-0000000000b1', 'x@288.test');
INSERT INTO public.camps (id, owner, name) VALUES ('f2880000-0000-0000-0000-000000000001', 'f2880000-0000-0000-0000-0000000000a1', 'Dispute Camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('f2880000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object('families', jsonb_build_object(
  'teal', jsonb_build_object('name', 'Teal', 'camperIds', jsonb_build_array('Ari Teal'),
     'plans', jsonb_build_array(
        jsonb_build_object('id', 'p1', 'autopay', true, 'dueDates', jsonb_build_array('2026-07-01')),
        jsonb_build_object('id', 'p2', 'autopay', false, 'dueDates', jsonb_build_array('2026-08-01')))),
  'fern', jsonb_build_object('name', 'Fern', 'camperIds', jsonb_build_array('Bo Fern')),
  'ash', jsonb_build_object('name', 'Ash', 'camperIds', jsonb_build_array('Cy Ash'),
     'plan', jsonb_build_object('autopay', true, 'installments', jsonb_build_array(jsonb_build_object('dueDate', '2026-07-01', 'amount', 500, 'status', 'pending')))))));

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
    IF f->'plans'->1->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback' THEN
        RAISE EXCEPTION 'TED-200: a plan without autopay was not paused (autopay switched on mid-dispute would charge): %', f->'plans'->1;
    END IF;
    IF NOT (f->'disputeHold'->'disputeIds') ? 'dp_1' THEN RAISE EXCEPTION 'TED-200: the family itself is not paused: %', f->'disputeHold'; END IF;
    -- a family with no plan, and the old single plan
    r := public.hold_autopay_for_dispute(c, 'fern', 'dp_f', true, NULL);
    f := public.camp_family(c, 'fern');
    IF NOT COALESCE((f->'disputeHold'->'disputeIds') ? 'dp_f', false) THEN RAISE EXCEPTION 'TED-200: a family with no plan is not paused: %', f; END IF;
    r := public.hold_autopay_for_dispute(c, 'ash', 'dp_a', true, NULL);
    f := public.camp_family(c, 'ash');
    IF f->'plan'->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback' OR NOT COALESCE((f->'disputeHold'->'disputeIds') ? 'dp_a', false) THEN
        RAISE EXCEPTION 'TED-201: the old single plan is not paused: %', f;
    END IF;
    r := public.hold_autopay_for_dispute(c, 'ash', 'dp_a', false);
    f := public.camp_family(c, 'ash');
    IF f ? 'disputeHold' OR f->'plan' ? 'collectionBlocked' THEN RAISE EXCEPTION 'TED-201: won, Ash still paused: %', f; END IF;
    SELECT count(*) INTO n FROM notifications WHERE camp_id = c AND source = 'autopay_blocked' AND source_id LIKE 'teal:%';
    IF n <> 1 THEN RAISE EXCEPTION 'notices: %', n; END IF;

    -- 2. an old tab saves Teal
    r := public.sync_camp_billing(c, jsonb_build_object('teal', (SELECT copy FROM stale) || '{"note":"x"}'::jsonb), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback' THEN
        RAISE EXCEPTION 'an old tab took the pause off: %', f->'plans';
    END IF;
    IF NOT COALESCE((f->'disputeHold'->'disputeIds') ? 'dp_1', false) THEN
        RAISE EXCEPTION 'TED-200: an old tab took the family''s pause off: %', f;
    END IF;
    -- a tab that loaded Fern before the dispute adds an autopay plan: Fern stays paused
    r := public.sync_camp_billing(c, jsonb_build_object('fern', jsonb_build_object('name', 'Fern', 'camperIds', jsonb_build_array('Bo Fern'),
            'plans', jsonb_build_array(jsonb_build_object('id', 'pf', 'autopay', true, 'dueDates', jsonb_build_array('2026-07-01'))))),
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'fern');
    IF NOT COALESCE((f->'disputeHold'->'disputeIds') ? 'dp_f', false) OR f->'plans'->0->>'id' IS DISTINCT FROM 'pf' THEN
        RAISE EXCEPTION 'TED-200: a new plan saved mid-dispute lost the family''s pause: %', f;
    END IF;
    -- a tab carrying a pause the server no longer has cannot put it back
    r := public.sync_camp_billing(c, jsonb_build_object('fern', f || '{"disputeHold":{"disputeIds":["dp_fake"]}}'::jsonb), '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
    f := public.camp_family(c, 'fern');
    IF (f->'disputeHold'->'disputeIds') ? 'dp_fake' THEN RAISE EXCEPTION 'a page wrote the pause: %', f->'disputeHold'; END IF;

    -- 3. won — only that dispute's mark comes off
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_other', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked' IS NULL THEN RAISE EXCEPTION 'another dispute took the pause off'; END IF;
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_1', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0 ? 'collectionBlocked' OR f->'plans'->1 ? 'collectionBlocked' OR f ? 'disputeHold' THEN RAISE EXCEPTION 'won: still paused: %', f; END IF;

    -- 4. Resume: refused while the dispute is open; allowed once it is lost
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_2', true, NULL);
    r := public.resume_autopay_after_dispute(c, 'teal');
    IF r->>'error' IS DISTINCT FROM 'dispute_open' OR (r->>'open')::int <> 1 THEN RAISE EXCEPTION 'TED-202: resumed with a dispute still open: %', r; END IF;
    r := public.note_dispute_lost(c, 'teal', 'dp_2');
    IF (r->>'changed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'lost not noted: %', r; END IF;
    r := public.resume_autopay_after_dispute(c, 'teal');
    f := public.camp_family(c, 'teal');
    IF (r->>'success')::boolean IS NOT TRUE OR f->'plans'->0 ? 'collectionBlocked' OR f ? 'disputeHold' THEN RAISE EXCEPTION 'resume: % / %', r, f; END IF;
    -- TED-202: two disputes, one lost, one open — Resume is refused and says one is open
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_L', true, NULL);
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_O', true, NULL);
    PERFORM public.note_dispute_lost(c, 'teal', 'dp_L');
    r := public.resume_autopay_after_dispute(c, 'teal');
    f := public.camp_family(c, 'teal');
    IF r->>'error' IS DISTINCT FROM 'dispute_open' OR (r->>'open')::int <> 1 OR NOT (f->'disputeHold'->'disputeIds') ? 'dp_O' THEN
        RAISE EXCEPTION 'TED-202: Resume cleared a dispute still open: % / %', r, f->'disputeHold';
    END IF;
    -- ...unless the office says so
    r := public.resume_autopay_after_dispute(c, 'teal', true);
    f := public.camp_family(c, 'teal');
    IF (r->>'changed')::boolean IS NOT TRUE OR f ? 'disputeHold' OR f->'plans'->0 ? 'collectionBlocked' THEN RAISE EXCEPTION 'resume anyway: % / %', r, f; END IF;

    -- TED-193: two disputes — winning one keeps the pause until the other closes
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_A', true, NULL);
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_B', true, NULL);
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_A', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback'
       OR NOT (f->'plans'->0->'collectionBlocked'->'disputeIds') ? 'dp_B' THEN
        RAISE EXCEPTION 'TED-193: winning one of two disputes restarted autopay: %', f->'plans'->0;
    END IF;
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_B', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0 ? 'collectionBlocked' THEN RAISE EXCEPTION 'both closed, still paused: %', f->'plans'->0; END IF;

    -- TED-197: a declined card's wait is kept under the pause and comes back
    PERFORM public.flag_plan_collection(c, 'teal', 'p1', 'declined', 'card declined');
    f := public.camp_family(c, 'teal');
    n := 0;
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_C', true, NULL);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->'under'->>'reason' IS DISTINCT FROM 'declined' THEN
        RAISE EXCEPTION 'TED-197/204: the first pause did not keep the decline under it: %', f->'plans'->0;
    END IF;
    -- TED-194: the runner's "no card" while paused goes under the pause, never over it
    PERFORM public.flag_plan_collection(c, 'teal', 'p1', 'no_card', 'no card on file');
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->>'reason' IS DISTINCT FROM 'chargeback'
       OR f->'plans'->0->'collectionBlocked'->'under'->>'reason' IS DISTINCT FROM 'no_card' THEN
        RAISE EXCEPTION 'TED-194: a no-card mark replaced the dispute pause: %', f->'plans'->0;
    END IF;
    PERFORM public.flag_plan_collection(c, 'teal', 'p1', 'declined', 'card declined');
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_C', false);
    f := public.camp_family(c, 'teal');
    IF f->'plans'->0->'collectionBlocked'->>'reason' IS DISTINCT FROM 'declined'
       OR f->'plans'->0->'collectionBlocked'->>'nextRetryAt' IS NULL THEN
        RAISE EXCEPTION 'TED-197: the decline wait did not come back after the dispute: %', f->'plans'->0;
    END IF;
    PERFORM public.flag_plan_collection(c, 'teal', 'p1', NULL, NULL);

    -- TED-196: a late message for a dispute already won pauses nothing
    f := public.camp_family_for_update(c, 'teal');
    PERFORM public.camp_family_save(c, 'teal', f || jsonb_build_object('entries',
        COALESCE(f->'entries', '[]'::jsonb) || '[{"id":"le_cbwon_dp_W","kind":"payment","amount":0,"reason":"chargeback"}]'::jsonb));
    r := public.hold_autopay_for_dispute(c, 'teal', 'dp_W', true, NULL);
    f := public.camp_family(c, 'teal');
    IF (r->>'alreadyWon')::boolean IS NOT TRUE OR f->'plans'->0 ? 'collectionBlocked' THEN
        RAISE EXCEPTION 'TED-196: a late message after a win paused autopay: % / %', r, f->'plans'->0;
    END IF;

    -- 5. grants
    IF has_function_privilege('authenticated', 'public.hold_autopay_for_dispute(uuid,text,text,boolean,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a browser can pause or resume autopay by dispute';
    END IF;
    RAISE NOTICE 'ok  288: a chargeback pauses autopay; stale tabs keep it; won resumes; the office resumes after a loss';
END $$;

-- a stranger cannot resume; nor can camp staff without Billing edit (TED-199 M12)
INSERT INTO auth.users (id, email) VALUES ('f2880000-0000-0000-0000-0000000000c1', 'c@288.test');
INSERT INTO camp_users (camp_id, user_id, role, accepted_at) VALUES ('f2880000-0000-0000-0000-000000000001', 'f2880000-0000-0000-0000-0000000000c1', 'counselor', now());
SELECT set_config('t288.uid', 'f2880000-0000-0000-0000-0000000000c1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2880000-0000-0000-0000-0000000000c1"}', false);
-- The section resolver here is a stub answering 'edit' to everyone (pgstubs);
-- swapped for one answering 'view' to test 288's own gate (as pgtest 240 does).
CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_section text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $fn$ SELECT 'view'::text $fn$;
DO $$
DECLARE r jsonb;
BEGIN
    PERFORM public.hold_autopay_for_dispute('f2880000-0000-0000-0000-000000000001', 'teal', 'dp_v', true, NULL);
    r := public.resume_autopay_after_dispute('f2880000-0000-0000-0000-000000000001', 'teal', true);
    IF r->>'error' IS DISTINCT FROM 'not_authorized' THEN RAISE EXCEPTION 'TED-199: staff without Billing edit resumed autopay: %', r; END IF;
    PERFORM public.hold_autopay_for_dispute('f2880000-0000-0000-0000-000000000001', 'teal', 'dp_v', false);
END $$;
SELECT set_config('t288.uid', 'f2880000-0000-0000-0000-0000000000b1', false);
SELECT set_config('request.jwt.claims', '{"sub":"f2880000-0000-0000-0000-0000000000b1"}', false);
DO $$
DECLARE r jsonb;
BEGIN
    PERFORM public.hold_autopay_for_dispute('f2880000-0000-0000-0000-000000000001', 'teal', 'dp_3', true, NULL);
    r := public.resume_autopay_after_dispute('f2880000-0000-0000-0000-000000000001', 'teal', true);
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

-- TED-204 (N14): an earlier copy of 288 is named by the checking script
BEGIN;
CREATE OR REPLACE FUNCTION public._mark_plans_for_dispute(p_fam jsonb, p_dispute_id text, p_hold boolean, p_detail text)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT p_fam /* disputeIds, pass-20 copy */ $fn$;
CREATE TEMP TABLE v288b AS :verify_q
DO $$
DECLARE r text;
BEGIN
    SELECT result INTO r FROM v288b WHERE item LIKE '288%';
    IF r NOT LIKE 'apply 288 again%' THEN RAISE EXCEPTION 'TED-204: the checking script missed an earlier 288: %', r; END IF;
END $$;
ROLLBACK;
