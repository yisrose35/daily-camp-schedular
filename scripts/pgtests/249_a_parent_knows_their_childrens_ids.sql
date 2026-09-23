-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 249: a parent sees their own children's STAMPED ids —
-- never another family's, never one guessed from a name.
-- uuids are prefixed a4900000-.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;
INSERT INTO auth.users (id, email) VALUES
    ('a4900000-0000-0000-0000-0000000000bb', 'parent@249.test'),
    ('a4900000-0000-0000-0000-0000000000cc', 'other@249.test');
INSERT INTO camps (id, name) VALUES ('a4900000-0000-0000-0000-000000000001', '249 camp');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name) VALUES
    ('a4900000-0000-0000-0000-000000000001', 4901, 'camper', 'Mine', 'Mine'),
    ('a4900000-0000-0000-0000-000000000001', 4902, 'camper', 'Theirs', 'Theirs');
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, status) VALUES
    ('a4900000-0000-0000-0000-000000000001', 'a4900000-0000-0000-0000-0000000000bb', 'parent@249.test', '["Mine"]', 'active'),
    ('a4900000-0000-0000-0000-000000000001', 'a4900000-0000-0000-0000-0000000000cc', 'other@249.test',  '["Theirs"]', 'active');

SET "request.jwt.claims" = '{"sub":"a4900000-0000-0000-0000-0000000000bb"}';
DO $$
DECLARE v jsonb := public.get_my_camper_ids('a4900000-0000-0000-0000-000000000001');
BEGIN
    IF v->'campers' IS DISTINCT FROM '[{"campId":"a4900000-0000-0000-0000-000000000001","name":"Mine","camperId":4901}]'::jsonb THEN
        RAISE EXCEPTION 'expected only Mine → 4901: %', v;
    END IF;
END $$;

-- An unstamped slot comes back with no id — nothing is resolved from the name.
UPDATE link_parent_invites SET person_ids = '[null]'::jsonb
 WHERE user_id = 'a4900000-0000-0000-0000-0000000000bb';
DO $$
DECLARE v jsonb := public.get_my_camper_ids(NULL);
BEGIN
    IF (v->'campers'->0->'camperId') IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'an unstamped slot was given an id from its name: %', v;
    END IF;
END $$;

RESET "request.jwt.claims";
DO $$
BEGIN
    IF jsonb_array_length(public.get_my_camper_ids(NULL)->'campers') <> 0 THEN
        RAISE EXCEPTION 'a signed-out caller got ids';
    END IF;
END $$;
ROLLBACK;
