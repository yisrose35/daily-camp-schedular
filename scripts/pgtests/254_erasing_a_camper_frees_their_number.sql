-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 254: erasing a camper removes everything tied to their
-- number, and only then is the number free — and the next holder starts empty.
--
--   1. refused while the camper is on the roster
--   2. refused while their canteen account holds money
--   3. the dry run changes nothing
--   4. the erase: rows deleted, family money detached (amount kept), the
--      invitation shortened, documents scrubbed, family records untouched
--   5. the number is free, and a new camper given it inherits NOTHING
--   6. a name an enrolled camper shares is never used to erase
--   7. only the camp's admin
--
-- uuids are prefixed a5400000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a5400000-0000-0000-0000-0000000000aa', 'owner@254.test'),
    ('a5400000-0000-0000-0000-0000000000bb', 'stranger@254.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a5400000-0000-0000-0000-000000000001', '254 camp', 'a5400000-0000-0000-0000-0000000000aa');

INSERT INTO camp_state_kv (camp_id, key, value) VALUES
 ('a5400000-0000-0000-0000-000000000001', 'app1',
  '{"camperRoster":{"Avi":{"name":"Avi","camperId":10},"Bina":{"name":"Bina","camperId":11}},
    "bunks":{"B1":["Avi","Bina"]}}'),
 ('a5400000-0000-0000-0000-000000000001', 'campistryHealth',
  '{"sickVisits":[{"camperName":"Avi","complaint":"cough"},{"camperName":"Bina","complaint":"cut"}],
    "dispensingLog":[{"camperId":10,"medication":"x"},{"camperId":11,"medication":"y"}],
    "medicalForms":{"Avi":{"ok":true},"Bina":{"ok":true}}}'),
 ('a5400000-0000-0000-0000-000000000001', 'campistryMe',
  '{"families":{"f1":{"camperIds":["Avi"],"name":"Avi family"}}}');

INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('a5400000-0000-0000-0000-000000000001', 'Avi', 10, 'Avi', 5);
INSERT INTO canteen_transactions (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, payload)
VALUES ('a5400000-0000-0000-0000-000000000001', 'avi-1', 'Avi', '10', 'credit', 5, '2026-07-01', '{}');
INSERT INTO pickup_alerts (camp_id, camper_name, camper_bunk)
VALUES ('a5400000-0000-0000-0000-000000000001', 'Avi', 'B1');
INSERT INTO link_health_submissions (camp_id, camper_name, file_name)
VALUES ('a5400000-0000-0000-0000-000000000001', 'Avi', 'shots.pdf'),
       ('a5400000-0000-0000-0000-000000000001', 'Bina', 'shots.pdf');
INSERT INTO link_tips (camp_id, camper_name, recipient_name, amount)
VALUES ('a5400000-0000-0000-0000-000000000001', 'Avi', 'Counselor', 18);
INSERT INTO link_parent_invites (camp_id, parent_email, camper_names, camper_data, status)
VALUES ('a5400000-0000-0000-0000-000000000001', 'mom@254.test', '["Avi","Bina"]',
        '{"Avi":{"bunk":"B1"},"Bina":{"bunk":"B1"}}', 'active');

DO $$
DECLARE c uuid := 'a5400000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
    IF (SELECT person_id FROM pickup_alerts WHERE camp_id = c) IS DISTINCT FROM 10
       OR (SELECT person_ids FROM link_parent_invites WHERE camp_id = c) IS DISTINCT FROM '[10, 11]'::jsonb THEN
        RAISE EXCEPTION 'fixture: rows were not stamped with Avi''s number';
    END IF;

    -- 1.
    v := public.erase_camper(c, 10, true);
    IF v->>'error' IS DISTINCT FROM 'still_enrolled' THEN
        RAISE EXCEPTION 'a camper on the roster was erasable: %', v;
    END IF;

    -- Avi is deleted from the roster (and his bunk list, as the page does).
    UPDATE camp_state_kv SET value = value #- '{camperRoster,Avi}' WHERE camp_id = c AND key = 'app1';

    -- 2.
    v := public.erase_camper(c, 10, true);
    IF v->>'error' IS DISTINCT FROM 'canteen_balance' THEN
        RAISE EXCEPTION 'a camper with money on their account was erased: %', v;
    END IF;
    UPDATE camp_canteen_accounts SET balance = 0 WHERE camp_id = c AND person_id = 10;

    -- 3.
    v := public.erase_camper(c, 10);
    IF (v->>'dry_run')::boolean IS NOT TRUE OR (v->'would_delete'->>'pickup_alerts')::int <> 1 THEN
        RAISE EXCEPTION 'the dry run is wrong: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 10)
       OR NOT EXISTS (SELECT 1 FROM pickup_alerts WHERE camp_id = c) THEN
        RAISE EXCEPTION 'the dry run deleted something';
    END IF;

    -- 4.
    v := public.erase_camper(c, 10, true);
    IF (v->>'erased')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the erase did not run: %', v;
    END IF;
    IF EXISTS (SELECT 1 FROM pickup_alerts WHERE camp_id = c)
       OR EXISTS (SELECT 1 FROM camp_canteen_accounts WHERE camp_id = c AND (person_id = 10 OR camper_name = 'Avi'))
       OR EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = c AND camper_id = '10')
       OR EXISTS (SELECT 1 FROM link_health_submissions WHERE camp_id = c AND camper_name = 'Avi') THEN
        RAISE EXCEPTION 'rows tied to the erased number survived: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM link_health_submissions WHERE camp_id = c AND camper_name = 'Bina') THEN
        RAISE EXCEPTION 'another camper''s rows were erased';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM link_tips WHERE camp_id = c AND person_id IS NULL
                      AND camper_name = '(erased camper)' AND amount = 18) THEN
        RAISE EXCEPTION 'the tip (money) was not detached with its amount kept: %',
            (SELECT row(person_id, camper_name, amount)::text FROM link_tips WHERE camp_id = c);
    END IF;
    IF (SELECT row(camper_names, person_ids, camper_data)::text FROM link_parent_invites WHERE camp_id = c)
       IS DISTINCT FROM row('["Bina"]'::jsonb, '[11]'::jsonb, '{"Bina":{"bunk":"B1"}}'::jsonb)::text THEN
        RAISE EXCEPTION 'the invitation still names the erased camper: %',
            (SELECT row(camper_names, person_ids, camper_data)::text FROM link_parent_invites WHERE camp_id = c);
    END IF;
    IF (SELECT value FROM camp_state_kv WHERE camp_id = c AND key = 'campistryHealth')
       IS DISTINCT FROM '{"sickVisits":[{"camperName":"Bina","complaint":"cut"}],
                          "dispensingLog":[{"camperId":11,"medication":"y"}],
                          "medicalForms":{"Bina":{"ok":true}}}'::jsonb THEN
        RAISE EXCEPTION 'the health document still holds the erased camper: %',
            (SELECT value FROM camp_state_kv WHERE camp_id = c AND key = 'campistryHealth');
    END IF;
    IF (SELECT value #> '{bunks,B1}' FROM camp_state_kv WHERE camp_id = c AND key = 'app1') IS DISTINCT FROM '["Bina"]'::jsonb THEN
        RAISE EXCEPTION 'the bunk list still names the erased camper';
    END IF;
    IF (SELECT value #> '{families,f1,camperIds}' FROM camp_state_kv WHERE camp_id = c AND key = 'campistryMe')
       IS DISTINCT FROM '["Avi"]'::jsonb THEN
        RAISE EXCEPTION 'the family record (money) was touched';
    END IF;

    -- 5. the number is free, and the next holder starts with nothing
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 10) THEN
        RAISE EXCEPTION 'the number is still held after the erase';
    END IF;
    UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Chana}', '{"name":"Chana","camperId":10}')
     WHERE camp_id = c AND key = 'app1';
    IF (SELECT person_id FROM camp_people WHERE camp_id = c AND source_key = 'Chana') IS DISTINCT FROM 10 THEN
        RAISE EXCEPTION 'the freed number could not be given out';
    END IF;
    IF EXISTS (SELECT 1 FROM pickup_alerts WHERE camp_id = c AND person_id = 10)
       OR EXISTS (SELECT 1 FROM link_tips WHERE camp_id = c AND person_id = 10)
       OR EXISTS (SELECT 1 FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 10)
       OR EXISTS (SELECT 1 FROM canteen_transactions WHERE camp_id = c AND camper_id = '10')
       OR EXISTS (SELECT 1 FROM link_parent_invites WHERE camp_id = c AND person_ids @> '[10]') THEN
        RAISE EXCEPTION 'the new holder of number 10 inherited the erased camper''s data';
    END IF;
END $$;

-- 6. a shared name: a departed Dov, and an enrolled camper also called Dov
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster}', value->'camperRoster'
        || '{"Dov":{"name":"Dov","camperId":20}}') WHERE camp_id = 'a5400000-0000-0000-0000-000000000001' AND key = 'app1';
UPDATE camp_state_kv SET value = value #- '{camperRoster,Dov}' WHERE camp_id = 'a5400000-0000-0000-0000-000000000001' AND key = 'app1';
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Dov 2}', '{"name":"Dov","camperId":21}')
 WHERE camp_id = 'a5400000-0000-0000-0000-000000000001' AND key = 'app1';
UPDATE camp_people SET name = 'Dov' WHERE camp_id = 'a5400000-0000-0000-0000-000000000001' AND person_id = 21;
-- Since 259 a roster key is one child's: "Dov" is the departed #20's, and the
-- enrolled Dov is filed under "Dov 2". So a record with no number filed under
-- "Dov" is #20's and goes with him; a record carrying #21's number stays,
-- whatever name it shows, and so does one filed under "Dov 2".
UPDATE camp_state_kv SET value = jsonb_set(value, '{sickVisits}', value->'sickVisits'
        || '[{"camperName":"Dov","complaint":"fever"},
             {"camperName":"Dov","camperId":21,"complaint":"cough"},
             {"camperName":"Dov 2","complaint":"rash"}]')
 WHERE camp_id = 'a5400000-0000-0000-0000-000000000001' AND key = 'campistryHealth';
DO $$
DECLARE c uuid := 'a5400000-0000-0000-0000-000000000001'; v jsonb; left_ text[];
BEGIN
    v := public.erase_camper(c, 20, true);
    IF (v->>'name_shared_with_an_enrolled_camper')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the shared name was not noticed: %', v;
    END IF;
    SELECT array_agg(s->>'complaint' ORDER BY s->>'complaint') INTO left_
      FROM camp_state_kv, jsonb_array_elements(value->'sickVisits') s
     WHERE camp_id = c AND key = 'campistryHealth' AND s->>'camperName' IN ('Dov', 'Dov 2');
    IF left_ IS DISTINCT FROM ARRAY['cough', 'rash'] THEN
        RAISE EXCEPTION 'expected only the enrolled Dov''s records to remain (cough, rash), got %', left_;
    END IF;
END $$;

-- 7. a stranger
SET "request.jwt.claims" = '{"sub":"a5400000-0000-0000-0000-0000000000bb","role":"authenticated"}';
DO $$
BEGIN
    IF public.erase_camper('a5400000-0000-0000-0000-000000000001', 11, true)->>'error' IS DISTINCT FROM 'forbidden' THEN
        RAISE EXCEPTION 'a stranger could erase a camper';
    END IF;
END $$;
RESET "request.jwt.claims";

ROLLBACK;

-- ─── merge_campers: a duplicate's history goes to the camper who stays ──────
BEGIN;
INSERT INTO camps (id, name) VALUES ('a5400000-0000-0000-0000-000000000002', '254 merge camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5400000-0000-0000-0000-000000000002', 'app1',
    '{"camperRoster":{"Eli":{"name":"Eli","camperId":30},"Eli S":{"name":"Eli S","camperId":31}}}');
INSERT INTO pickup_alerts (camp_id, camper_name, person_id, camper_bunk)
VALUES ('a5400000-0000-0000-0000-000000000002', 'Eli S', 31, 'B1');
INSERT INTO link_parent_invites (camp_id, parent_email, camper_names, person_ids, status)
VALUES ('a5400000-0000-0000-0000-000000000002', 'p@254.test', '["Eli S"]', '[31]', 'active');
DO $$
DECLARE c uuid := 'a5400000-0000-0000-0000-000000000002'; v jsonb;
BEGIN
    IF public.merge_campers(c, 30, 31)->>'error' IS DISTINCT FROM 'still_enrolled' THEN
        RAISE EXCEPTION 'merged a camper who is still on the roster';
    END IF;
    UPDATE camp_state_kv SET value = value #- '{camperRoster,Eli S}' WHERE camp_id = c AND key = 'app1';
    v := public.merge_campers(c, 30, 31);
    IF (v->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'merge failed: %', v; END IF;
    IF (SELECT person_id FROM pickup_alerts WHERE camp_id = c) IS DISTINCT FROM 30
       OR (SELECT person_ids FROM link_parent_invites WHERE camp_id = c) IS DISTINCT FROM '[30]'::jsonb THEN
        RAISE EXCEPTION 'the duplicate''s records did not move to the camper who stays';
    END IF;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 31) THEN
        RAISE EXCEPTION 'the duplicate''s number is still held';
    END IF;
END $$;
ROLLBACK;
