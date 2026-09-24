-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 259: a roster key belongs to one child for as long as
-- anything about that child exists.
--
--   1. Avi Katz #10 leaves. A new Avi Katz is filed under "Avi Katz #11",
--      shown as "Avi Katz" — not under #10's key.
--   2. A page that has not adopted that key saves "Avi Katz" again, without
--      the number: still #11, still "Avi Katz #11" — no third number.
--   3. The same page saves "Avi Katz" WITH #11: filed under "Avi Katz #11".
--   4. Ayala Weiss #5 is renamed; a new Ayala Weiss does not get her old key.
--   5. #10 comes back (Undo) under "Avi Katz": the key is his, he keeps it.
--   6. The Me page is told which keys a new child may not have.
--   7. Once #10 is erased, "Avi Katz" is free for a new child.
--   0. And a RENAME, saved the way the pages save (an upsert), keeps the
--      camper's number. Before 259 it gave them a new one and left their
--      money and history on the old number, marked departed.
--
-- uuids are prefixed a5900000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES ('a5900000-0000-0000-0000-0000000000aa', 'owner@259.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a5900000-0000-0000-0000-000000000001', '259 camp', 'a5900000-0000-0000-0000-0000000000aa');

CREATE FUNCTION pg_temp.roster() RETURNS jsonb LANGUAGE sql AS $$
    SELECT value -> 'camperRoster' FROM camp_state_kv
     WHERE camp_id = 'a5900000-0000-0000-0000-000000000001' AND key = 'app1'
$$;
CREATE FUNCTION pg_temp.save(r jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO camp_state_kv (camp_id, key, value)
    VALUES ('a5900000-0000-0000-0000-000000000001', 'app1', jsonb_build_object('camperRoster', r))
    ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value
$$;

SELECT pg_temp.save('{"Avi Katz":{"name":"Avi Katz","camperId":10},"Ayala Weiss":{"name":"Ayala Weiss","camperId":5}}');

DO $$
DECLARE r jsonb;
BEGIN
    -- 0. A rename keeps the number.
    PERFORM pg_temp.save('{"Avi Katz":{"name":"Avi Katz","camperId":10},"Ayala Weiss-K":{"name":"Ayala Weiss-K","camperId":5}}');
    IF (pg_temp.roster() #>> '{Ayala Weiss-K,camperId}') IS DISTINCT FROM '5'
       OR EXISTS (SELECT 1 FROM camp_people WHERE camp_id = 'a5900000-0000-0000-0000-000000000001'
                   AND person_id = 5 AND (deleted_at IS NOT NULL OR source_key <> 'Ayala Weiss-K')) THEN
        RAISE EXCEPTION 'a rename lost the camper''s number: % / %', pg_temp.roster(),
            (SELECT jsonb_agg(jsonb_build_object('id', person_id, 'key', source_key, 'gone', deleted_at IS NOT NULL))
               FROM camp_people WHERE camp_id = 'a5900000-0000-0000-0000-000000000001');
    END IF;
    PERFORM pg_temp.save('{"Avi Katz":{"name":"Avi Katz","camperId":10},"Ayala Weiss":{"name":"Ayala Weiss","camperId":5}}');

    -- 1. #10 leaves; a new Avi Katz arrives with no number.
    PERFORM pg_temp.save('{"Ayala Weiss":{"name":"Ayala Weiss","camperId":5}}');
    PERFORM pg_temp.save('{"Ayala Weiss":{"name":"Ayala Weiss","camperId":5},"Avi Katz":{"name":"Avi Katz","bunk":"B1"}}');
    r := pg_temp.roster();
    IF r ? 'Avi Katz' THEN
        RAISE EXCEPTION 'the new Avi was filed under the departed Avi''s key: %', r;
    END IF;
    IF (r #>> '{Avi Katz #11,camperId}') IS DISTINCT FROM '11'
       OR (r #>> '{Avi Katz #11,displayName}') IS DISTINCT FROM 'Avi Katz'
       OR (r #>> '{Avi Katz #11,bunk}') IS DISTINCT FROM 'B1' THEN
        RAISE EXCEPTION 'the new Avi is not "Avi Katz #11", shown as "Avi Katz", with his data: %', r;
    END IF;

    -- 2. A page that did not adopt the key saves the old shape again.
    PERFORM pg_temp.save('{"Ayala Weiss":{"name":"Ayala Weiss","camperId":5},"Avi Katz":{"name":"Avi Katz","bunk":"B2"}}');
    r := pg_temp.roster();
    IF r ? 'Avi Katz' OR (r #>> '{Avi Katz #11,camperId}') IS DISTINCT FROM '11'
       OR (r #>> '{Avi Katz #11,bunk}') IS DISTINCT FROM 'B2' THEN
        RAISE EXCEPTION 'a page that has not adopted the key made a new child: %', r;
    END IF;
    IF (SELECT count(*) FROM camp_people WHERE camp_id = 'a5900000-0000-0000-0000-000000000001'
         AND kind = 'camper') <> 3 THEN
        RAISE EXCEPTION 'a number was minted for a child who already has one: %',
            (SELECT jsonb_agg(jsonb_build_object('id', person_id, 'key', source_key, 'gone', deleted_at IS NOT NULL))
               FROM camp_people WHERE camp_id = 'a5900000-0000-0000-0000-000000000001');
    END IF;

    -- 3. …and with the number.
    PERFORM pg_temp.save('{"Ayala Weiss":{"name":"Ayala Weiss","camperId":5},"Avi Katz":{"name":"Avi Katz","camperId":11,"bunk":"B3"}}');
    r := pg_temp.roster();
    IF r ? 'Avi Katz' OR (r #>> '{Avi Katz #11,bunk}') IS DISTINCT FROM 'B3' THEN
        RAISE EXCEPTION 'a stated number did not keep the child under their own key: %', r;
    END IF;

    -- 4. Ayala is renamed; a new Ayala Weiss arrives.
    PERFORM pg_temp.save(jsonb_build_object('Ayala Weiss-Katz', '{"name":"Ayala Weiss-Katz","camperId":5}'::jsonb,
                                            'Avi Katz #11', r -> 'Avi Katz #11'));
    r := pg_temp.roster();
    PERFORM pg_temp.save(r || '{"Ayala Weiss":{"name":"Ayala Weiss"}}');
    r := pg_temp.roster();
    IF r ? 'Ayala Weiss' OR NOT (r ? 'Ayala Weiss #12') THEN
        RAISE EXCEPTION 'a new child got the renamed child''s old key: %', r;
    END IF;

    -- 6. The page is told.
    IF (public.get_camper_numbers('a5900000-0000-0000-0000-000000000001') #>> '{held_keys,Avi Katz}') IS DISTINCT FROM '10' THEN
        -- (read as the owner below; here as nobody, so expect not_authorized)
        NULL;
    END IF;
    IF (public.verify_roster_keys() -> 'keys_shown_by_the_wrong_child') <> '[]'::jsonb THEN
        RAISE EXCEPTION 'a key is shown by the wrong child: %', public.verify_roster_keys();
    END IF;
END $$;

SET "request.jwt.claims" = '{"sub":"a5900000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb; r jsonb;
BEGIN
    v := public.get_camper_numbers('a5900000-0000-0000-0000-000000000001');
    IF (v #>> '{held_keys,Avi Katz}') IS DISTINCT FROM '10'
       OR (v #>> '{held_keys,Ayala Weiss}') IS DISTINCT FROM '5' THEN
        RAISE EXCEPTION 'the page is not told which keys are held: %', v -> 'held_keys';
    END IF;

    -- 5. #10 comes back under his own key.
    r := pg_temp.roster();
    PERFORM pg_temp.save(r || '{"Avi Katz":{"name":"Avi Katz","camperId":10}}');
    r := pg_temp.roster();
    IF (r #>> '{Avi Katz,camperId}') IS DISTINCT FROM '10' OR (r #>> '{Avi Katz #11,camperId}') IS DISTINCT FROM '11' THEN
        RAISE EXCEPTION 'the returning #10 did not get his key back: %', r;
    END IF;

    -- 7. He leaves again and is erased: his key is free — and nothing filed
    --    under it is left for the next child who gets it. (254 alone skipped
    --    this, because the live "Avi Katz #11" shows the same name.)
    PERFORM pg_temp.save(r - 'Avi Katz');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5900000-0000-0000-0000-000000000001', 'luggage259',
        '{"bookings":[{"camperName":"Avi Katz","bags":2},{"camperName":"Avi Katz #11","bags":1},
                      {"camperName":"Avi Katz","camperId":11,"bags":5}],
          "bunks":{"B1":["Avi Katz","Avi Katz #11"]}}');
    v := public.erase_camper('a5900000-0000-0000-0000-000000000001', 10, true);
    IF (v ->> 'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'erase refused: %', v; END IF;
    IF (SELECT value FROM camp_state_kv WHERE camp_id = 'a5900000-0000-0000-0000-000000000001' AND key = 'luggage259')
       IS DISTINCT FROM '{"bookings":[{"camperName":"Avi Katz #11","bags":1},{"camperName":"Avi Katz","camperId":11,"bags":5}],"bunks":{"B1":["Avi Katz #11"]}}'::jsonb THEN
        RAISE EXCEPTION 'the erase left records under the key it freed (or touched #11''s): %',
            (SELECT value FROM camp_state_kv WHERE camp_id = 'a5900000-0000-0000-0000-000000000001' AND key = 'luggage259');
    END IF;
    IF EXISTS (SELECT 1 FROM camp_person_keys WHERE camp_id = 'a5900000-0000-0000-0000-000000000001' AND person_id = 10) THEN
        RAISE EXCEPTION 'the erased child still holds keys';
    END IF;
    r := pg_temp.roster();
    PERFORM pg_temp.save(r || '{"Avi Katz":{"name":"Avi Katz"}}');
    r := pg_temp.roster();
    IF NOT (r ? 'Avi Katz') THEN
        RAISE EXCEPTION 'the erased child''s key was not free for a new child: %', r;
    END IF;
    IF (public.verify_roster_keys() -> 'keys_shown_by_the_wrong_child') <> '[]'::jsonb
       OR (public.verify_roster_keys() ->> 'unrecorded_keys')::int <> 0 THEN
        RAISE EXCEPTION 'verify_roster_keys: %', public.verify_roster_keys();
    END IF;
END $$;
RESET "request.jwt.claims";

ROLLBACK;
