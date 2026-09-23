-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 257: a camper number reaches THAT camper — including one
-- who has left, when a new child now has their name (Ted, TED-001).
--
-- "Avi Katz" #10 leaves with money on his canteen account. A new "Avi Katz"
-- enrols and is #11. Everything sent with #10 must reach #10's account, and
-- everything sent with #11 must reach #11's — through every path that turns
-- a number into a name and back: the 248 wrappers, the office desk, the
-- register, the offline import, history.
--
-- uuids are prefixed a5700000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES ('a5700000-0000-0000-0000-0000000000aa', 'owner@257.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a5700000-0000-0000-0000-000000000001', '257 camp', 'a5700000-0000-0000-0000-0000000000aa');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5700000-0000-0000-0000-000000000001', 'app1',
    '{"camperRoster":{"Avi Katz":{"name":"Avi Katz","camperId":10}}}');

SET "request.jwt.claims" = '{"sub":"a5700000-0000-0000-0000-0000000000aa"}';
SELECT public.canteen_office_credit('a5700000-0000-0000-0000-000000000001', 'Avi Katz', 5, p_camper_id => 10);
RESET "request.jwt.claims";

-- He leaves; a new Avi Katz arrives and the server numbers him.
UPDATE camp_state_kv SET value = '{"camperRoster":{}}' WHERE camp_id = 'a5700000-0000-0000-0000-000000000001' AND key = 'app1';
UPDATE camp_state_kv SET value = '{"camperRoster":{"Avi Katz":{"name":"Avi Katz"}}}'
 WHERE camp_id = 'a5700000-0000-0000-0000-000000000001' AND key = 'app1';

CREATE FUNCTION pg_temp.bal(p bigint) RETURNS numeric LANGUAGE sql AS $$
    SELECT COALESCE(sum(balance), 0) FROM camp_canteen_accounts
     WHERE camp_id = 'a5700000-0000-0000-0000-000000000001' AND person_id = p
$$;
CREATE FUNCTION pg_temp.expect(label text, p10 numeric, p11 numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF pg_temp.bal(10) IS DISTINCT FROM p10 OR pg_temp.bal(11) IS DISTINCT FROM p11 THEN
        RAISE EXCEPTION '%: expected #10 = % and #11 = %, got #10 = % and #11 = %',
            label, p10, p11, pg_temp.bal(10), pg_temp.bal(11);
    END IF;
END $$;

DO $$
DECLARE c uuid := 'a5700000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
    -- (since 259 the new Avi is filed under "Avi Katz #11", shown as "Avi Katz")
    IF (SELECT person_id FROM camp_people WHERE camp_id = c AND deleted_at IS NULL
         AND regexp_replace(source_key, '\s#\d+(?:-\d+)?$', '') = 'Avi Katz')
       IS DISTINCT FROM 11 THEN
        RAISE EXCEPTION 'setup: the new Avi Katz is not #11';
    END IF;
    PERFORM pg_temp.expect('setup', 5, 0);
    IF public.verify_number_round_trip() -> 'numbers_that_miss_their_camper' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'a number does not come back to its camper: %', public.verify_number_round_trip();
    END IF;

    -- 248 wrappers: a late card payment for the child who left
    PERFORM public.credit_canteen_balance_from_stripe(c, 'Avi Katz', 25, 'pi_257_a', p_camper_id => 10);
    PERFORM pg_temp.expect('a Stripe credit for #10', 30, 0);
    PERFORM public.credit_canteen_balance_from_processor(c, 'Avi Katz', 10, 'banquest', 'bq_257_a', p_camper_id => 10);
    PERFORM pg_temp.expect('a processor credit for #10', 40, 0);
    PERFORM public.refund_canteen_deposit_from_stripe(c, 'Avi Katz', 25, 'pi_257_a', 're_257_a', p_camper_id => 10);
    PERFORM pg_temp.expect('a Stripe refund for #10', 15, 0);

    -- and the same for the child who is here
    PERFORM public.credit_canteen_balance_from_stripe(c, 'Avi Katz', 7, 'pi_257_b', p_camper_id => 11);
    PERFORM pg_temp.expect('a Stripe credit for #11', 15, 7);

    IF NOT public.canteen_camper_known(c, 'Avi Katz', 10) THEN
        RAISE EXCEPTION 'the departed #10 is not known to the canteen';
    END IF;

    v := public.get_canteen_history(c, 'Avi Katz', p_camper_id => 10);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v->'transactions', v->'rows', '[]')) t
                WHERE (t->>'camperId') IS DISTINCT FROM '10') THEN
        RAISE EXCEPTION '#10''s history shows another child''s rows: %', v;
    END IF;

END $$;

-- the office desk and the register, as the owner
SET "request.jwt.claims" = '{"sub":"a5700000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE c uuid := 'a5700000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
    -- the offline register's import, by number
    v := public.canteen_office_import_offline(c,
        '[{"id":"o257","camper":"Avi Katz","camperId":10,"amount":2,"type":"debit","date":"2026-07-10"}]');
    IF (v->>'imported')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'offline import refused: %', v; END IF;
    PERFORM pg_temp.expect('an offline sale for #10', 13, 7);
    PERFORM public.canteen_office_credit(c, 'Avi Katz', 4, p_camper_id => 10);
    PERFORM pg_temp.expect('an office credit for #10', 17, 7);
    v := public.canteen_office_cash_out(c, 'Avi Katz', 17, p_note => 'left camp', p_camper_id => 10);
    IF (v->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'cash-out refused: %', v; END IF;
    PERFORM pg_temp.expect('cashing #10 out', 0, 7);
    PERFORM public.canteen_office_credit(c, 'Avi Katz', 1, p_camper_id => 11);
    PERFORM pg_temp.expect('an office credit for #11', 0, 8);
    PERFORM public.submit_canteen_purchase(c, 'Avi Katz', 2, 'Chips', p_camper_id => 11);
    PERFORM pg_temp.expect('a purchase for #11', 0, 6);
    -- and by key alone (a page from before numbers): each key reaches the
    -- child it belongs to — since 259 the new Avi is "Avi Katz #11" and
    -- "Avi Katz" stays the departed #10's.
    PERFORM public.canteen_office_credit(c, 'Avi Katz #11', 1);
    PERFORM pg_temp.expect('an office credit by the new Avi''s key', 0, 7);
    PERFORM public.canteen_office_credit(c, 'Avi Katz', 1);
    PERFORM pg_temp.expect('an office credit by the departed Avi''s key', 1, 7);
END $$;
RESET "request.jwt.claims";

ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- Two ENROLLED children who both show as "Sam Cohen" (#1, roster key
-- "Sam Cohen"; #2, roster key "Sam Cohen #2"), each with their own parent.
-- Every parent path, by number: forms, face consent, headshot, health
-- documents, canteen limits. Each lands on that parent's own child, and a
-- parent cannot reach the other child by sending the other child's number.
-- Plus two children whose keys differ only in capitals and spacing, paid by
-- number at the office desk.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a5700000-0000-0000-0000-0000000000a2', 'owner2@257.test'),
    ('a5700000-0000-0000-0000-0000000000b1', 'parentA@257.test'),
    ('a5700000-0000-0000-0000-0000000000b2', 'parentB@257.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a5700000-0000-0000-0000-000000000002', '257 camp two', 'a5700000-0000-0000-0000-0000000000a2');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5700000-0000-0000-0000-000000000002', 'app1',
    '{"camperRoster":{"Sam Cohen":{"name":"Sam Cohen","camperId":1},"Sam Cohen #2":{"name":"Sam Cohen","camperId":2},
                      "Chaim Katz":{"name":"Chaim Katz","camperId":890},"chaim katz  ":{"name":"Chaim Katz","camperId":891}}}');
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, person_ids, status) VALUES
    ('a5700000-0000-0000-0000-000000000002', 'a5700000-0000-0000-0000-0000000000b1', 'parentA@257.test', '["Sam Cohen"]', '[1]', 'active'),
    ('a5700000-0000-0000-0000-000000000002', 'a5700000-0000-0000-0000-0000000000b2', 'parentB@257.test', '["Sam Cohen"]', '[2]', 'active');

SET "request.jwt.claims" = '{"sub":"a5700000-0000-0000-0000-0000000000b2"}';
DO $$
DECLARE c uuid := 'a5700000-0000-0000-0000-000000000002'; v jsonb; ok boolean;
BEGIN
    v := public.submit_link_form_response('f257', 'Allergies', 'digital', 'Sam Cohen', '2', p_camp_id => c::text);
    IF (SELECT person_id FROM link_form_responses WHERE camp_id = c AND form_id = 'f257') IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'parent B''s form was filed on another child: % / %', v,
            (SELECT jsonb_agg(person_id) FROM link_form_responses WHERE camp_id = c);
    END IF;

    v := public.set_camper_face_consent(c, 'Sam Cohen', true, 2);
    IF EXISTS (SELECT 1 FROM link_camper_faces WHERE camp_id = c AND person_id IS DISTINCT FROM 2) THEN
        RAISE EXCEPTION 'parent B''s face consent was filed on another child: %', v;
    END IF;
    v := public.submit_camper_headshot(c, 'Sam Cohen', 'data:image/png;base64,AA', (SELECT jsonb_agg(0.01) FROM generate_series(1,128)), p_camper_id => 2);
    IF EXISTS (SELECT 1 FROM link_camper_face_descriptors WHERE camp_id = c AND person_id IS DISTINCT FROM 2)
       OR NOT EXISTS (SELECT 1 FROM link_camper_face_descriptors WHERE camp_id = c) THEN
        RAISE EXCEPTION 'parent B''s headshot was not filed on #2: %', v;
    END IF;

    v := public.submit_health_document(c, 'Sam Cohen', 'shots.pdf', 'application/pdf', 'data:application/pdf;base64,AA', p_camper_id => 2);
    IF (SELECT person_id FROM link_health_submissions WHERE camp_id = c) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'parent B''s health document was filed on another child: %', v;
    END IF;

    v := public.set_canteen_limits('Sam Cohen', 5, p_camp_id => c, p_camper_id => 2);
    IF (SELECT daily_limit FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 2) IS DISTINCT FROM 5
       OR EXISTS (SELECT 1 FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 1) THEN
        RAISE EXCEPTION 'parent B''s canteen limit did not land on #2 alone: %', v;
    END IF;

    -- The other child's number is refused to parent B, on every path.
    v := public.set_canteen_limits('Sam Cohen', 9, p_camp_id => c, p_camper_id => 1);
    IF EXISTS (SELECT 1 FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 1) THEN
        RAISE EXCEPTION 'parent B set a limit on parent A''s child: %', v;
    END IF;
    v := public.set_camper_face_consent(c, 'Sam Cohen', true, 1);
    IF EXISTS (SELECT 1 FROM link_camper_faces WHERE camp_id = c AND person_id = 1) THEN
        RAISE EXCEPTION 'parent B set face consent for parent A''s child: %', v;
    END IF;
    v := public.submit_health_document(c, 'Sam Cohen', 'x.pdf', 'application/pdf', 'data:application/pdf;base64,AA', p_camper_id => 1);
    IF EXISTS (SELECT 1 FROM link_health_submissions WHERE camp_id = c AND person_id = 1) THEN
        RAISE EXCEPTION 'parent B filed a health document on parent A''s child: %', v;
    END IF;
    ok := public.verify_my_camper(c::text, 'Sam Cohen', 1);
    IF ok THEN RAISE EXCEPTION 'parent B is told they own parent A''s child'; END IF;
    IF NOT public.verify_my_camper(c::text, 'Sam Cohen', 2) THEN
        RAISE EXCEPTION 'parent B is not told they own their own child';
    END IF;

    -- Withdrawing consent for #2 leaves #1 alone (and #1 has none to lose).
    v := public.set_camper_face_consent(c, 'Sam Cohen', false, 2);
    IF EXISTS (SELECT 1 FROM link_camper_face_descriptors WHERE camp_id = c AND person_id = 2) THEN
        RAISE EXCEPTION 'withdrawing consent left #2''s face data: %', v;
    END IF;
END $$;
RESET "request.jwt.claims";

-- Two keys that differ only in capitals and spacing, paid by number.
SET "request.jwt.claims" = '{"sub":"a5700000-0000-0000-0000-0000000000a2"}';
DO $$
DECLARE c uuid := 'a5700000-0000-0000-0000-000000000002';
BEGIN
    PERFORM public.canteen_office_credit(c, 'Chaim Katz', 4, p_camper_id => 891);
    PERFORM public.canteen_office_credit(c, 'Chaim Katz', 6, p_camper_id => 890);
    IF (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 891) IS DISTINCT FROM 4
       OR (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 890) IS DISTINCT FROM 6 THEN
        RAISE EXCEPTION 'look-alike keys: money by number reached the wrong child: %',
            (SELECT jsonb_agg(jsonb_build_object('p', person_id, 'b', balance)) FROM camp_canteen_accounts WHERE camp_id = c);
    END IF;
END $$;
RESET "request.jwt.claims";

ROLLBACK;

-- Two departed children whose names differ only in capitals, nobody enrolled
-- under either: each number still comes back to its own child.
BEGIN;
INSERT INTO camps (id, name) VALUES ('a5700000-0000-0000-0000-000000000003', '257 camp three');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, deleted_at) VALUES
    ('a5700000-0000-0000-0000-000000000003', 31, 'camper', 'Dov Stern', 'Dov Stern', now()),
    ('a5700000-0000-0000-0000-000000000003', 32, 'camper', 'dov stern', 'dov stern', now());
DO $$
BEGIN
    IF public.verify_number_round_trip() -> 'numbers_that_miss_their_camper' <> '[]'::jsonb
       OR public.verify_number_round_trip() -> 'enrolled_names_that_miss_their_camper' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'two departed look-alikes: %', public.verify_number_round_trip();
    END IF;
    -- No number is ever added to a name.
    IF public.camp_person_label('a5700000-0000-0000-0000-000000000003', 31) <> 'Dov Stern' THEN
        RAISE EXCEPTION 'a number was added to a name: %', public.camp_person_label('a5700000-0000-0000-0000-000000000003', 31);
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- Ted's TED-006 case: "Sam Cohen" is #2 and another child is stored as
-- "Sam Cohen #2", who is #5. The name "Sam Cohen #2" means #5 — whatever
-- number happens to follow it — and each child's money reaches them by name
-- and by number. No number is ever added to anybody's name.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO auth.users (id, email) VALUES ('a5700000-0000-0000-0000-0000000000a4', 'owner4@257.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a5700000-0000-0000-0000-000000000004', '257 camp four', 'a5700000-0000-0000-0000-0000000000a4');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5700000-0000-0000-0000-000000000004', 'app1',
    '{"camperRoster":{"Sam Cohen":{"name":"Sam Cohen","camperId":2},"Sam Cohen #2":{"name":"Sam Cohen","camperId":5}}}');
SET "request.jwt.claims" = '{"sub":"a5700000-0000-0000-0000-0000000000a4"}';
DO $$
DECLARE c uuid := 'a5700000-0000-0000-0000-000000000004';
BEGIN
    IF public.camp_person_by_name(c, 'Sam Cohen #2') IS DISTINCT FROM 5 THEN
        RAISE EXCEPTION 'the name "Sam Cohen #2" does not mean #5: %', public.camp_person_by_name(c, 'Sam Cohen #2');
    END IF;
    PERFORM public.canteen_office_credit(c, 'Sam Cohen #2', 9);
    PERFORM public.canteen_office_credit(c, 'Sam Cohen', 1);
    PERFORM public.canteen_office_credit(c, 'Sam Cohen #2', 20, p_camper_id => 5);
    PERFORM public.canteen_office_credit(c, 'Sam Cohen', 300, p_camper_id => 2);
    IF (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 5) IS DISTINCT FROM 29
       OR (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 2) IS DISTINCT FROM 301 THEN
        RAISE EXCEPTION 'money reached the wrong child: %',
            (SELECT jsonb_agg(jsonb_build_object('p', person_id, 'key', account_key, 'b', balance)) FROM camp_canteen_accounts WHERE camp_id = c);
    END IF;
    IF EXISTS (SELECT 1 FROM camp_canteen_accounts WHERE camp_id = c AND (account_key ~ '#\d+ #\d+$' OR camper_name ~ '#\d+ #\d+$')) THEN
        RAISE EXCEPTION 'a number was added to a name: %',
            (SELECT jsonb_agg(account_key) FROM camp_canteen_accounts WHERE camp_id = c);
    END IF;
    IF public.verify_number_round_trip() -> 'numbers_that_miss_their_camper' <> '[]'::jsonb
       OR public.verify_number_round_trip() -> 'enrolled_names_that_miss_their_camper' <> '[]'::jsonb
       OR public.verify_number_round_trip() -> 'functions_that_do_not_pin' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'the check reports: %', public.verify_number_round_trip();
    END IF;
END $$;
RESET "request.jwt.claims";
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- Ted's TED-008: "is this my child?" by number. Avi Katz #10 has left; the new
-- Avi Katz #11 is this parent's child. Asked about #10, the answer is no.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO auth.users (id, email) VALUES ('a5700000-0000-0000-0000-0000000000b5', 'parent5@257.test');
INSERT INTO camps (id, name) VALUES ('a5700000-0000-0000-0000-000000000005', '257 camp five');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5700000-0000-0000-0000-000000000005', 'app1',
    '{"camperRoster":{"Avi Katz":{"name":"Avi Katz","camperId":10}}}');
UPDATE camp_state_kv SET value = '{"camperRoster":{}}' WHERE camp_id = 'a5700000-0000-0000-0000-000000000005' AND key = 'app1';
UPDATE camp_state_kv SET value = '{"camperRoster":{"Avi Katz":{"name":"Avi Katz","camperId":11}}}'
 WHERE camp_id = 'a5700000-0000-0000-0000-000000000005' AND key = 'app1';
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, person_ids, status) VALUES
    ('a5700000-0000-0000-0000-000000000005', 'a5700000-0000-0000-0000-0000000000b5', 'parent5@257.test', '["Avi Katz"]', '[11]', 'active');
SET "request.jwt.claims" = '{"sub":"a5700000-0000-0000-0000-0000000000b5"}';
DO $$
DECLARE c text := 'a5700000-0000-0000-0000-000000000005';
BEGIN
    IF public.verify_my_camper(c, 'Avi Katz', 10) THEN
        RAISE EXCEPTION 'the new Avi''s parent is told they own the departed Avi #10';
    END IF;
    IF NOT public.verify_my_camper(c, 'Avi Katz', 11) THEN
        RAISE EXCEPTION 'the parent is not told they own their own child #11';
    END IF;
    -- By key alone: since 259 the parent's child is "Avi Katz #11"; the key
    -- "Avi Katz" is the departed #10's and is not theirs.
    IF NOT public.verify_my_camper(c, 'Avi Katz #11') THEN
        RAISE EXCEPTION 'by their own key the child is not the parent''s';
    END IF;
    IF public.verify_my_camper(c, 'Avi Katz') THEN
        RAISE EXCEPTION 'the departed Avi''s key reaches the new Avi''s parent';
    END IF;
END $$;
RESET "request.jwt.claims";
DO $$
BEGIN
    IF public.verify_number_round_trip() -> 'functions_that_do_not_pin' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'unpinned: %', public.verify_number_round_trip() -> 'functions_that_do_not_pin';
    END IF;
END $$;
ROLLBACK;
