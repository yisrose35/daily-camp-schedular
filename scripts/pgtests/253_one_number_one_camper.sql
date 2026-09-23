-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 253: one number, one camper; the server issues them.
--
--   1. two campers asking for one number in one save: one gets it, the other
--      gets another, and the SAVED ROSTER shows two different numbers
--   2. a stale tab re-sending a taken number is corrected, to the same number
--   3. a departed camper's number is not re-issued to a new child
--   4. ... but the same camper coming back (Undo) gets it back
--   5. a rename in one save keeps the number
--   6. staff and campers never share a number
--   7. an absurd number does not abort the save
--   8. the repair renumbers a roster that already shows duplicates
--   9. get_camper_numbers: live numbers, and a next number above every held one
--
-- uuids are prefixed a5300000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

BEGIN;

CREATE FUNCTION pg_temp.shows(c uuid, k text) RETURNS bigint LANGUAGE sql AS $$
    SELECT (value #>> ARRAY['camperRoster', k, 'camperId'])::bigint
      FROM camp_state_kv WHERE camp_id = c AND key = 'app1'
$$;
CREATE FUNCTION pg_temp.holds(c uuid, k text) RETURNS bigint LANGUAGE sql AS $$
    SELECT person_id FROM camp_people
     WHERE camp_id = c AND kind = 'camper' AND source_key = k AND deleted_at IS NULL
$$;
CREATE FUNCTION pg_temp.save(c uuid, roster jsonb) RETURNS void LANGUAGE sql AS $$
    UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster}', roster)
     WHERE camp_id = c AND key = 'app1'
$$;

INSERT INTO camps (id, name) VALUES ('a5300000-0000-0000-0000-000000000001', '253 camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5300000-0000-0000-0000-000000000001', 'app1',
    '{"camperRoster":{"Avi":{"name":"Avi","camperId":10},"Bina":{"name":"Bina","camperId":10}}}');

DO $$
DECLARE c uuid := 'a5300000-0000-0000-0000-000000000001'; b bigint;
BEGIN
    -- 1.
    IF pg_temp.shows(c, 'Avi') = pg_temp.shows(c, 'Bina') THEN
        RAISE EXCEPTION 'the saved roster shows two campers with number %', pg_temp.shows(c, 'Avi');
    END IF;
    IF pg_temp.shows(c, 'Avi') <> pg_temp.holds(c, 'Avi') OR pg_temp.shows(c, 'Bina') <> pg_temp.holds(c, 'Bina') THEN
        RAISE EXCEPTION 'the roster shows numbers the campers do not hold';
    END IF;
    IF pg_temp.holds(c, 'Avi') <> 10 THEN
        RAISE EXCEPTION 'the first to ask did not get the number they asked for';
    END IF;
    b := pg_temp.holds(c, 'Bina');

    -- 2. a stale tab sends Bina = 10 again, twice
    PERFORM pg_temp.save(c, '{"Avi":{"name":"Avi","camperId":10},"Bina":{"name":"Bina","camperId":10,"bunk":"B1"}}');
    PERFORM pg_temp.save(c, '{"Avi":{"name":"Avi","camperId":10},"Bina":{"name":"Bina","camperId":10,"bunk":"B2"}}');
    IF pg_temp.shows(c, 'Bina') <> b OR pg_temp.holds(c, 'Bina') <> b THEN
        RAISE EXCEPTION 'a stale duplicate moved Bina off her number (% → %)', b, pg_temp.shows(c, 'Bina');
    END IF;

    -- 3. Avi is deleted (a save of its own, as the Me page does); later a new
    -- child is typed in with Avi's number. (Both in ONE save is a rename: the
    -- number goes with the entry that replaced him, which is the rule in 5.)
    PERFORM pg_temp.save(c, jsonb_build_object('Bina', jsonb_build_object('name','Bina','camperId',b)));
    PERFORM pg_temp.save(c, jsonb_build_object('Bina', jsonb_build_object('name','Bina','camperId',b),
                                               'Chana', '{"name":"Chana","camperId":10}'::jsonb));
    IF pg_temp.holds(c, 'Chana') = 10 OR pg_temp.shows(c, 'Chana') = 10 THEN
        RAISE EXCEPTION 'a departed camper''s number was handed to a new child';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 10
                    AND source_key = 'Avi' AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'the departed camper lost their number';
    END IF;

    -- 4. Undo: Avi comes back under his own entry
    PERFORM pg_temp.save(c, jsonb_build_object('Bina', jsonb_build_object('name','Bina','camperId',b),
                                               'Chana', jsonb_build_object('name','Chana','camperId',pg_temp.holds(c,'Chana')),
                                               'Avi', '{"name":"Avi","camperId":10}'::jsonb));
    IF pg_temp.holds(c, 'Avi') IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'undoing a delete did not give the camper their number back';
    END IF;

    -- 5. rename Bina → Bina Katz in one save
    PERFORM pg_temp.save(c, jsonb_build_object('Bina Katz', jsonb_build_object('name','Bina Katz','camperId',b),
                                               'Chana', jsonb_build_object('name','Chana','camperId',pg_temp.holds(c,'Chana')),
                                               'Avi', '{"name":"Avi","camperId":10}'::jsonb));
    IF pg_temp.holds(c, 'Bina Katz') IS DISTINCT FROM b THEN
        RAISE EXCEPTION 'a rename did not keep the number';
    END IF;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND source_key = 'Bina') THEN
        RAISE EXCEPTION 'a rename left a second identity behind';
    END IF;

    -- 7. an absurd number: the save goes through, and the camper gets a real one
    PERFORM pg_temp.save(c, jsonb_build_object('Bina Katz', jsonb_build_object('name','Bina Katz','camperId',b),
                                               'Chana', jsonb_build_object('name','Chana','camperId',pg_temp.holds(c,'Chana')),
                                               'Avi', '{"name":"Avi","camperId":10}'::jsonb,
                                               'Dov', '{"name":"Dov","camperId":"123456789012345678901234567890"}'::jsonb));
    IF pg_temp.holds(c, 'Dov') IS NULL OR pg_temp.shows(c, 'Dov') <> pg_temp.holds(c, 'Dov') THEN
        RAISE EXCEPTION 'an absurd number was not replaced with a real one';
    END IF;
END $$;

-- 6. a staff member asking for a camper's number
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5300000-0000-0000-0000-000000000001', 'campistryMe',
    '{"staffApplications":{"app-1":{"name":"Counselor","staffId":10,"status":"hired"},"app-2":{"name":"Applicant","status":"new"}}}');
DO $$
DECLARE c uuid := 'a5300000-0000-0000-0000-000000000001'; s bigint;
BEGIN
    s := (SELECT (value #>> '{staffApplications,app-1,staffId}')::bigint FROM camp_state_kv WHERE camp_id = c AND key = 'campistryMe');
    IF s = 10 THEN
        RAISE EXCEPTION 'a staff member was shown a camper''s number';
    END IF;
    IF s IS DISTINCT FROM (SELECT person_id FROM camp_people WHERE camp_id = c AND kind = 'staff' AND source_key = 'app-1') THEN
        RAISE EXCEPTION 'the staff number shown is not the one held';
    END IF;
    IF (SELECT value #> '{staffApplications,app-2}' FROM camp_state_kv WHERE camp_id = c AND key = 'campistryMe') ? 'staffId' THEN
        RAISE EXCEPTION 'an applicant who was never hired was given a staff number';
    END IF;
    IF EXISTS (SELECT 1 FROM public.camper_number_problems() WHERE camp_id = c) THEN
        RAISE EXCEPTION 'problems remain: %', (SELECT jsonb_agg(p) FROM public.camper_number_problems() p WHERE camp_id = c);
    END IF;
END $$;

-- 9.
DO $$
DECLARE c uuid := 'a5300000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
    v := public.get_camper_numbers(c);
    IF (v->'campers'->>'Avi')::bigint <> 10 OR v->'campers' ? 'Bina' THEN
        RAISE EXCEPTION 'get_camper_numbers is wrong: %', v;
    END IF;
    IF (v->>'next')::bigint <= (SELECT max(person_id) FROM camp_people WHERE camp_id = c) THEN
        RAISE EXCEPTION 'next (%) is a number somebody holds', v->>'next';
    END IF;
END $$;

-- 8. the repair: a roster saved before 253 that shows duplicates
INSERT INTO camps (id, name) VALUES ('a5300000-0000-0000-0000-000000000002', '253 broken camp');
ALTER TABLE camp_state_kv DISABLE TRIGGER trg_zz_number_camp_campers;
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5300000-0000-0000-0000-000000000002', 'app1',
    '{"camperRoster":{"One":{"name":"One","camperId":5},"Two":{"name":"Two","camperId":5},"Three":{"name":"Three"}}}');
ALTER TABLE camp_state_kv ENABLE TRIGGER trg_zz_number_camp_campers;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.camper_number_problems() WHERE camp_id = 'a5300000-0000-0000-0000-000000000002') THEN
        RAISE EXCEPTION 'the checker does not see a duplicate';
    END IF;
END $$;
\ir ../../migrations/253_one_number_one_camper.sql
DO $$
DECLARE c uuid := 'a5300000-0000-0000-0000-000000000002';
BEGIN
    IF EXISTS (SELECT 1 FROM public.camper_number_problems() WHERE camp_id = c) THEN
        RAISE EXCEPTION 'the repair left problems: %', (SELECT jsonb_agg(p) FROM public.camper_number_problems() p WHERE camp_id = c);
    END IF;
    IF pg_temp.shows(c, 'One') = pg_temp.shows(c, 'Two') THEN
        RAISE EXCEPTION 'the repair left a duplicate';
    END IF;
END $$;

ROLLBACK;
