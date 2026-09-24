-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 255: a parent's family and enrollments are found by
-- camper NUMBER.
--
-- Two children called Sam Cohen: #1 (roster key "Sam Cohen", family A, $1,000)
-- and #2 (roster key "Sam Cohen #2", family B, $500). Both parents typed
-- "Sam Cohen" on their invitation; the invitations carry the numbers.
-- By name, parent B was shown family A's $1,000 bill. By number, $500.
--
-- uuids are prefixed a5500000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a5500000-0000-0000-0000-0000000000aa', 'owner@255.test'),
    ('a5500000-0000-0000-0000-0000000000b1', 'parentA@255.test'),
    ('a5500000-0000-0000-0000-0000000000b2', 'parentB@255.test');
INSERT INTO camps (id, name, owner)
VALUES ('a5500000-0000-0000-0000-000000000001', '255 camp', 'a5500000-0000-0000-0000-0000000000aa');

INSERT INTO camp_state_kv (camp_id, key, value) VALUES
 ('a5500000-0000-0000-0000-000000000001', 'app1',
  '{"camperRoster":{"Sam Cohen":{"name":"Sam Cohen","camperId":1},"Sam Cohen #2":{"name":"Sam Cohen","camperId":2}}}'),
 ('a5500000-0000-0000-0000-000000000001', 'campistryMe', jsonb_build_object(
    'sessions',    jsonb_build_array(jsonb_build_object('name', 'Full', 'tuition', 0)),
    'enrollments', jsonb_build_object(
        'e1', jsonb_build_object('camperName', 'Sam Cohen',    'status', 'enrolled', 'session', 'Full', 'sessionTuition', 1000),
        'e2', jsonb_build_object('camperName', 'Sam Cohen #2', 'status', 'enrolled', 'session', 'Full', 'sessionTuition', 500)),
    'families', jsonb_build_object(
        'famA', jsonb_build_object('name', 'Cohen A', 'camperIds', jsonb_build_array('Sam Cohen')),
        'famB', jsonb_build_object('name', 'Cohen B', 'camperIds', jsonb_build_array('Sam Cohen #2')))));

INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, person_ids, status) VALUES
 ('a5500000-0000-0000-0000-000000000001', 'a5500000-0000-0000-0000-0000000000b1', 'parentA@255.test', '["Sam Cohen"]', '[1]', 'active'),
 ('a5500000-0000-0000-0000-000000000001', 'a5500000-0000-0000-0000-0000000000b2', 'parentB@255.test', '["Sam Cohen"]', '[2]', 'active');

DO $$
BEGIN
    IF (SELECT person_ids FROM camp_families WHERE camp_id = 'a5500000-0000-0000-0000-000000000001' AND family_key = 'famB')
       IS DISTINCT FROM '[2]'::jsonb THEN
        RAISE EXCEPTION 'setup: family B was not stamped with #2';
    END IF;
    IF public.verify_parent_matching_on_numbers() -> 'still_matching_children_by_name' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'functions still match children by name: %', public.verify_parent_matching_on_numbers();
    END IF;
END $$;

-- Both paths of the balance: the document one and the projection one.
CREATE FUNCTION pg_temp.balance_for(p_user text) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
    v := public.get_my_balance_derived('a5500000-0000-0000-0000-000000000001');
    IF NOT COALESCE((v->>'success')::boolean, false) THEN RAISE EXCEPTION 'balance failed: %', v; END IF;
    RETURN (v->>'balance')::numeric;
END $$;

DO $$
DECLARE a numeric; b numeric; path text;
BEGIN
    FOREACH path IN ARRAY ARRAY['document', 'projection'] LOOP
        IF path = 'document' THEN
            UPDATE camp_billing_config SET blob_updated_at = blob_updated_at - interval '1 day'
             WHERE camp_id = 'a5500000-0000-0000-0000-000000000001';
        ELSE
            UPDATE camp_billing_config c SET blob_updated_at = k.updated_at FROM camp_state_kv k
             WHERE c.camp_id = 'a5500000-0000-0000-0000-000000000001' AND k.camp_id = c.camp_id AND k.key = 'campistryMe';
        END IF;
        a := pg_temp.balance_for('a5500000-0000-0000-0000-0000000000b1');
        b := pg_temp.balance_for('a5500000-0000-0000-0000-0000000000b2');
        IF a IS DISTINCT FROM 1000 OR b IS DISTINCT FROM 500 THEN
            RAISE EXCEPTION '% path: parent A should owe 1000 and B 500 (their own child''s), got A=% B=%', path, a, b;
        END IF;
    END LOOP;
END $$;

-- The helpers, directly: a name match with a DIFFERENT number is not a match;
-- a name match where one side has no number still is.
DO $$
DECLARE c uuid := 'a5500000-0000-0000-0000-000000000001';
BEGIN
    IF public._family_is_parents(c, 'famA', '{"camperIds":["Sam Cohen"]}', '["Sam Cohen"]', '[2]') THEN
        RAISE EXCEPTION 'family A was matched to the parent of #2 by name';
    END IF;
    IF NOT public._family_is_parents(c, 'famA', '{"camperIds":["Sam Cohen"]}', '["Sam Cohen"]', '[null]') THEN
        RAISE EXCEPTION 'an invitation with no number lost the name fallback';
    END IF;
    IF public._enrollment_is_parents(c, 'e1', '{"camperName":"Sam Cohen"}', '["Sam Cohen"]', '[2]') THEN
        RAISE EXCEPTION 'enrollment e1 (#1) was matched to the parent of #2 by name';
    END IF;
    IF NOT public._enrollment_is_parents(c, 'e2', '{"camperName":"Sam Cohen #2"}', '["Someone Else"]', '[2]') THEN
        RAISE EXCEPTION 'enrollment e2 was not matched by number';
    END IF;
END $$;

ROLLBACK;
