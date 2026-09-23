-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 260: a camper's number stays with that child.
--
--   1. (TED-010) A family's invitation: Avi #2 withdraws — Moshe keeps #1,
--      not Avi's #2. A sibling added in front gets their own number. A name
--      held only by a departed child is not given that child's number.
--   2. (TED-012) Avi is renumbered 1 → 7: his medication record inside the
--      Health document moves to 7, so a new child later given #1 does not
--      inherit it.
--   3. (TED-011) A child split in two by the 253 rename bug is found by
--      split_renames() and put back together on the original number, with
--      their money.
--
-- uuids are prefixed a6000000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000001', '260 camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a6000000-0000-0000-0000-000000000001', 'app1',
    '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1},"Avi Gold":{"name":"Avi Gold","camperId":2},
                      "Ghost Kid":{"name":"Ghost Kid","camperId":3}}}');
-- Ghost Kid leaves.
UPDATE camp_state_kv SET value = '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1},"Avi Gold":{"name":"Avi Gold","camperId":2}}}'
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000001' AND key = 'app1';

INSERT INTO link_parent_invites (id, camp_id, parent_email, camper_names, status)
VALUES ('a6000000-aaaa-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'gold@260.test',
        '["Avi Gold","Moshe Gold"]', 'active');

DO $$
DECLARE v jsonb;
BEGIN
    IF (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000001')
       IS DISTINCT FROM '[2,1]'::jsonb THEN
        RAISE EXCEPTION 'setup: %', (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000001');
    END IF;

    -- Avi withdraws: the office's save rewrites the names only (131's UPDATE).
    UPDATE link_parent_invites SET camper_names = '["Moshe Gold"]', camper_data = '{"Moshe Gold":{"camperId":1}}'
     WHERE id = 'a6000000-aaaa-0000-0000-000000000001';
    IF (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000001')
       IS DISTINCT FROM '[1]'::jsonb THEN
        RAISE EXCEPTION 'TED-010: Moshe was given his sibling''s number: %',
            (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000001');
    END IF;

    -- A sibling added IN FRONT, with no camper_data for her.
    UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Dina Gold}', '{"name":"Dina Gold","camperId":5}')
     WHERE camp_id = 'a6000000-0000-0000-0000-000000000001' AND key = 'app1';
    UPDATE link_parent_invites SET camper_names = '["Dina Gold","Moshe Gold"]', camper_data = '{}'
     WHERE id = 'a6000000-aaaa-0000-0000-000000000001';
    IF (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000001')
       IS DISTINCT FROM '[5,1]'::jsonb THEN
        RAISE EXCEPTION 'TED-010: a sibling added in front took another child''s number: %',
            (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000001');
    END IF;

    -- A name held only by a departed child is not given that child's number.
    INSERT INTO link_parent_invites (id, camp_id, parent_email, camper_names, status)
    VALUES ('a6000000-aaaa-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000001', 'ghost@260.test',
            '["Ghost Kid"]', 'active');
    IF (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000002')
       IS DISTINCT FROM '[null]'::jsonb THEN
        RAISE EXCEPTION 'an invitation was given a departed child''s number by name: %',
            (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000002');
    END IF;

    IF public.verify_invite_numbers() -> 'slots_on_the_wrong_child' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'verify_invite_numbers: %', public.verify_invite_numbers();
    END IF;
END $$;

-- 2. A renumber takes the saved documents with it.
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a6000000-0000-0000-0000-000000000001', 'campistryHealth',
    '{"dispensingLog":[{"camperName":"Moshe Gold","camperId":1,"medication":"Tylenol"},
                       {"camperName":"Avi Gold","camperId":2,"medication":"Advil"}]}');
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Moshe Gold,camperId}', '7')
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000001' AND key = 'app1';
DO $$
DECLARE h jsonb;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = 'a6000000-0000-0000-0000-000000000001'
                    AND person_id = 7 AND source_key = 'Moshe Gold' AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'setup: the renumber did not happen';
    END IF;
    SELECT value INTO h FROM camp_state_kv WHERE camp_id = 'a6000000-0000-0000-0000-000000000001' AND key = 'campistryHealth';
    IF h #>> '{dispensingLog,0,camperId}' IS DISTINCT FROM '7' OR h #>> '{dispensingLog,1,camperId}' IS DISTINCT FROM '2' THEN
        RAISE EXCEPTION 'TED-012: the renumber left records on the old number (or moved another child''s): %', h;
    END IF;
END $$;
-- a new child is given #1
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Dov Roth}', '{"name":"Dov Roth","camperId":1}')
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000001' AND key = 'app1';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM camp_state_kv, jsonb_array_elements(value -> 'dispensingLog') d
                WHERE camp_id = 'a6000000-0000-0000-0000-000000000001' AND key = 'campistryHealth'
                  AND d ->> 'camperId' = '1') THEN
        RAISE EXCEPTION 'TED-012: the new #1 inherited Moshe''s medication record';
    END IF;
END $$;

DO $$
BEGIN
    IF pg_get_functiondef('public.get_my_camper_photos(uuid,text)'::regprocedure) !~ '''camper_id'',\s*t\.person_id' THEN
        RAISE EXCEPTION 'a parent''s photos do not carry the child''s number';
    END IF;
END $$;

ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. A child split by the 253 rename bug, as that bug left them: #1 departed
--    with the money, #2 minted at the same instant under the new name.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000002', '260 camp two');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload, deleted_at, first_seen, updated_at)
VALUES ('a6000000-0000-0000-0000-000000000002', 1, 'camper', 'Ayala Weiss', 'Ayala Weiss', false,
        '{"name":"Ayala Weiss","dob":"2015-02-02"}', '2026-07-01 10:00:00+00', '2026-06-01 10:00:00+00', '2026-07-01 10:00:00+00'),
       ('a6000000-0000-0000-0000-000000000002', 2, 'camper', 'Ayala Weiss-Katz', 'Ayala Weiss-Katz', true,
        '{"name":"Ayala Weiss-Katz","dob":"2015-02-02"}', NULL, '2026-07-01 10:00:00+00', '2026-07-01 10:00:00+00'),
       -- a DIFFERENT child added in the same save: different birthday, must not be merged
       ('a6000000-0000-0000-0000-000000000002', 3, 'camper', 'Rina Stone', 'Rina Stone', true,
        '{"name":"Rina Stone","dob":"2016-03-03"}', NULL, '2026-07-01 10:00:00+00', '2026-07-01 10:00:00+00');
INSERT INTO camp_person_keys (camp_id, kind, key, person_id) VALUES
    ('a6000000-0000-0000-0000-000000000002', 'camper', 'Ayala Weiss', 1),
    ('a6000000-0000-0000-0000-000000000002', 'camper', 'Ayala Weiss-Katz', 2),
    ('a6000000-0000-0000-0000-000000000002', 'camper', 'Rina Stone', 3);
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
    ('a6000000-0000-0000-0000-000000000002', 'app1',
     '{"camperRoster":{"Ayala Weiss-Katz":{"name":"Ayala Weiss-Katz","camperId":2,"dob":"2015-02-02"},
                       "Rina Stone":{"name":"Rina Stone","camperId":3,"dob":"2016-03-03"}}}'),
    ('a6000000-0000-0000-0000-000000000002', 'campistryHealth',
     '{"sickVisits":[{"camperName":"Ayala Weiss-Katz","camperId":2,"complaint":"fever"}]}');
INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('a6000000-0000-0000-0000-000000000002', 'Ayala Weiss', 1, 'Ayala Weiss', 50.00);

DO $$
DECLARE v jsonb; c uuid := 'a6000000-0000-0000-0000-000000000002';
BEGIN
    v := public.split_renames();
    IF jsonb_array_length(v -> 'split_children') <> 1
       OR (v #>> '{split_children,0,original_number}') <> '1' OR (v #>> '{split_children,0,split_number}') <> '2' THEN
        RAISE EXCEPTION 'TED-011: the split child is not found exactly (and only): %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 2) THEN
        RAISE EXCEPTION 'the dry run changed something';
    END IF;

    v := public.split_renames(true);
    IF (v ->> 'repaired')::int <> 1 THEN RAISE EXCEPTION 'repair: %', v; END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 1
                    AND source_key = 'Ayala Weiss-Katz' AND deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 2) THEN
        RAISE EXCEPTION 'she is not back on her original number: %',
            (SELECT jsonb_agg(to_jsonb(p) - 'payload') FROM camp_people p WHERE camp_id = c);
    END IF;
    IF (SELECT value #>> '{camperRoster,Ayala Weiss-Katz,camperId}' FROM camp_state_kv WHERE camp_id = c AND key = 'app1') <> '1'
       OR (SELECT value #>> '{sickVisits,0,camperId}' FROM camp_state_kv WHERE camp_id = c AND key = 'campistryHealth') <> '1' THEN
        RAISE EXCEPTION 'her saved records do not show her original number: %',
            (SELECT jsonb_object_agg(key, value) FROM camp_state_kv WHERE camp_id = c);
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 1) <> 50 THEN
        RAISE EXCEPTION 'her money is not on her number';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 3 AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'a different child added in the same save was merged';
    END IF;
    IF jsonb_array_length(public.split_renames() -> 'split_children') <> 0 THEN
        RAISE EXCEPTION 'still reported after the repair';
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. (TED-016, TED-017) A renumber saved the way the Me page saves: app1 and
--    campistryMe in ONE upsert. The save goes through; every document, and
--    the family's invitation, follow; the old number is never given out.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000004', '260 camp four');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
    ('a6000000-0000-0000-0000-000000000004', 'app1',
     '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1}}}'),
    ('a6000000-0000-0000-0000-000000000004', 'campistryMe',
     '{"enrollments":{"e1":{"camperName":"Moshe Gold","camperId":1}}}'),
    ('a6000000-0000-0000-0000-000000000004', 'campistryHealth',
     '{"dispensingLog":[{"camperName":"Moshe Gold","camperId":1,"medication":"Tylenol"}]}');
INSERT INTO auth.users (id, email) VALUES ('a6000000-0000-0000-0000-0000000000b4', 'gold4@260.test');
INSERT INTO link_parent_invites (id, camp_id, user_id, parent_email, camper_names, camper_data, status)
VALUES ('a6000000-aaaa-0000-0000-000000000004', 'a6000000-0000-0000-0000-000000000004',
        'a6000000-0000-0000-0000-0000000000b4', 'gold4@260.test', '["Moshe Gold"]',
        '{"Moshe Gold":{"camperId":1}}', 'active');

-- The Me page's save: one statement, two documents.
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
    ('a6000000-0000-0000-0000-000000000004', 'app1',
     '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":7}}}'),
    ('a6000000-0000-0000-0000-000000000004', 'campistryMe',
     '{"enrollments":{"e1":{"camperName":"Moshe Gold","camperId":7}}}')
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;

-- The office's next invitation save (131's UPDATE), and a new child asking for #1.
UPDATE link_parent_invites SET camper_names = '["Moshe Gold"]', camper_data = '{"Moshe Gold":{"camperId":7}}'
 WHERE id = 'a6000000-aaaa-0000-0000-000000000004';
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
    ('a6000000-0000-0000-0000-000000000004', 'app1',
     '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":7},"Dina Stern":{"name":"Dina Stern","camperId":1}}}')
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;
-- A tab opened before the renumber saves the health log with the old number.
UPDATE camp_state_kv SET value = '{"dispensingLog":[{"camperName":"Moshe Gold","camperId":1,"medication":"Tylenol"},
                                                    {"camperName":"Moshe Gold","camperId":1,"medication":"Advil"}]}'
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000004' AND key = 'campistryHealth';

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6000000-0000-0000-0000-0000000000b4''::uuid';
DO $$
DECLARE c uuid := 'a6000000-0000-0000-0000-000000000004'; v jsonb;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 7 AND source_key = 'Moshe Gold') THEN
        RAISE EXCEPTION 'TED-016: the renumber did not reach the database: %',
            (SELECT jsonb_agg(to_jsonb(p) - 'payload') FROM camp_people p WHERE camp_id = c);
    END IF;
    IF (SELECT value #>> '{enrollments,e1,camperId}' FROM camp_state_kv WHERE camp_id = c AND key = 'campistryMe') <> '7' THEN
        RAISE EXCEPTION 'TED-016: the enrollment saved with the renumber did not reach the database';
    END IF;
    IF EXISTS (SELECT 1 FROM camp_state_kv, jsonb_array_elements(value -> 'dispensingLog') d
                WHERE camp_id = c AND key = 'campistryHealth' AND d ->> 'camperId' <> '7') THEN
        RAISE EXCEPTION 'TED-012: a health record is left on the old number: %',
            (SELECT value FROM camp_state_kv WHERE camp_id = c AND key = 'campistryHealth');
    END IF;
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 1) THEN
        RAISE EXCEPTION 'TED-017: the moved number 1 was given to another child';
    END IF;
    IF (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000004') <> '[7]'::jsonb THEN
        RAISE EXCEPTION 'TED-017: the invitation is not on the new number: %',
            (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000004');
    END IF;
    v := public.get_my_camper_ids(c);
    IF v -> 'campers' <> '[{"name":"Moshe Gold","campId":"a6000000-0000-0000-0000-000000000004","camperId":7}]'::jsonb THEN
        RAISE EXCEPTION 'TED-017: the parent''s portal is told %', v;
    END IF;
    IF NOT public._parent_owns_person(c, 7)
       OR public._parent_owns_person(c, (SELECT person_id FROM camp_people WHERE camp_id = c AND source_key = 'Dina Stern')) THEN
        RAISE EXCEPTION 'TED-017: Moshe''s parent owns the wrong child';
    END IF;
    IF public.verify_invite_numbers() ->> 'slots_on_a_moved_number' <> '0' THEN
        RAISE EXCEPTION 'verify_invite_numbers: %', public.verify_invite_numbers();
    END IF;
END $$;

-- A new child with no number, the counter rewound to 1: never given the moved #1.
INSERT INTO camp_person_seq (camp_id, next_id) VALUES ('a6000000-0000-0000-0000-000000000004', 1)
ON CONFLICT (camp_id) DO UPDATE SET next_id = 1;
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Leah Katz}', '{"name":"Leah Katz"}')
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000004' AND key = 'app1';
-- An invitation written by an old page with the old number is carried too.
DO $$
BEGIN
    IF (SELECT person_id FROM camp_people WHERE camp_id = 'a6000000-0000-0000-0000-000000000004'
         AND source_key = 'Leah Katz') IN (1, 7) THEN
        RAISE EXCEPTION 'TED-017: a new child was minted the moved number';
    END IF;
    UPDATE link_parent_invites SET person_ids = '[1]' WHERE id = 'a6000000-aaaa-0000-0000-000000000004';
    IF (SELECT person_ids FROM link_parent_invites WHERE id = 'a6000000-aaaa-0000-0000-000000000004') <> '[7]'::jsonb THEN
        RAISE EXCEPTION 'TED-017: an invitation written with the old number stayed on it';
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. (TED-020) Renamed and renumbered in one edit: one child, not two.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000005', '260 camp five');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
    ('a6000000-0000-0000-0000-000000000005', 'app1', '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1}}}'),
    ('a6000000-0000-0000-0000-000000000005', 'campistryHealth', '{"sickVisits":[{"camperName":"Moshe Gold","camperId":1}]}');
INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('a6000000-0000-0000-0000-000000000005', 'Moshe Gold', 1, 'Moshe Gold', 25.00);
INSERT INTO camp_state_kv (camp_id, key, value) VALUES
    ('a6000000-0000-0000-0000-000000000005', 'app1',
     '{"camperRoster":{"Moshe Goldberg":{"name":"Moshe Goldberg","camperId":9,"renumberedFrom":1}}}')
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;
DO $$
DECLARE c uuid := 'a6000000-0000-0000-0000-000000000005';
BEGIN
    IF (SELECT count(*) FROM camp_people WHERE camp_id = c) <> 1
       OR NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 9
                         AND source_key = 'Moshe Goldberg' AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'TED-020: rename + renumber split the child: %',
            (SELECT jsonb_agg(to_jsonb(p) - 'payload') FROM camp_people p WHERE camp_id = c);
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 9) IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'TED-020: his money did not come with him';
    END IF;
    IF (SELECT value #>> '{sickVisits,0,camperId}' FROM camp_state_kv WHERE camp_id = c AND key = 'campistryHealth') <> '9' THEN
        RAISE EXCEPTION 'TED-020: his health record did not come with him';
    END IF;
    IF (SELECT value -> 'camperRoster' FROM camp_state_kv WHERE camp_id = c AND key = 'app1') ? 'renumberedFrom'
       OR (SELECT value #> '{camperRoster,Moshe Goldberg}' FROM camp_state_kv WHERE camp_id = c AND key = 'app1') ? 'renumberedFrom' THEN
        RAISE EXCEPTION 'the renumber hint was stored';
    END IF;
END $$;
-- Renumbered DOWN (9 → 3): the counter still points at 9. A new child is
-- never minted the number Moshe moved off.
UPDATE camp_state_kv SET value = '{"camperRoster":{"Moshe Goldberg":{"name":"Moshe Goldberg","camperId":3}}}'
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000005' AND key = 'app1';
INSERT INTO camp_person_seq (camp_id, next_id) VALUES ('a6000000-0000-0000-0000-000000000005', 9)
ON CONFLICT (camp_id) DO UPDATE SET next_id = 9;
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Leah Katz}', '{"name":"Leah Katz"}')
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000005' AND key = 'app1';
DO $$
DECLARE c uuid := 'a6000000-0000-0000-0000-000000000005';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 3 AND source_key = 'Moshe Goldberg') THEN
        RAISE EXCEPTION 'setup: the second renumber did not happen';
    END IF;
    IF (SELECT person_id FROM camp_people WHERE camp_id = c AND source_key = 'Leah Katz') IN (1, 9) THEN
        RAISE EXCEPTION 'TED-017: a new child was minted a number Moshe moved off';
    END IF;
    IF (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 3) IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'his money did not follow the second move';
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. (TED-021) An erased child is not brought back by a tab opened before the
--    erase; the same child added again on purpose is.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000006', '260 camp six');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a6000000-0000-0000-0000-000000000006', 'app1',
    '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1},"Avi Gold":{"name":"Avi Gold","camperId":2}}}');
UPDATE camp_state_kv SET value = '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1}}}'
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000006' AND key = 'app1';
DO $$
DECLARE c uuid := 'a6000000-0000-0000-0000-000000000006'; v jsonb;
BEGIN
    v := public.erase_camper(c, 2, true);
    IF (v ->> 'number_is_free')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'setup: %', v; END IF;
END $$;
-- the stale tab
UPDATE camp_state_kv SET value = '{"camperRoster":{"Moshe Gold":{"name":"Moshe Gold","camperId":1},"Avi Gold":{"name":"Avi Gold","camperId":2}}}'
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000006' AND key = 'app1';
DO $$
DECLARE c uuid := 'a6000000-0000-0000-0000-000000000006';
BEGIN
    IF EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND source_key LIKE 'Avi Gold%')
       OR (SELECT value -> 'camperRoster' FROM camp_state_kv WHERE camp_id = c AND key = 'app1') ? 'Avi Gold' THEN
        RAISE EXCEPTION 'TED-021: a stale save brought the erased camper back';
    END IF;
END $$;
-- added again on purpose
UPDATE camp_state_kv SET value = jsonb_set(value, '{camperRoster,Avi Gold}',
        jsonb_build_object('name', 'Avi Gold', 'camperId', 2,
                           'addedAt', (extract(epoch FROM clock_timestamp()) * 1000 + 5000)::bigint))
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000006' AND key = 'app1';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = 'a6000000-0000-0000-0000-000000000006'
                    AND source_key = 'Avi Gold' AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'TED-021: a child added again on purpose was refused';
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. (TED-018) An invitation written before the child was enrolled: the
--    office's next save, which now carries the child's number, fills it.
--    (TED-019) The office's repair never picks a departed child by name.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO camps (id, name, owner) VALUES ('a6000000-0000-0000-0000-000000000007', '260 camp seven',
                                            'a6000000-0000-0000-0000-0000000000a7');
INSERT INTO link_parent_invites (id, camp_id, parent_email, camper_names, camper_data, status, person_ids_resolved_at)
VALUES ('a6000000-aaaa-0000-0000-000000000007', 'a6000000-0000-0000-0000-000000000007', 'stern@260.test',
        '["Rivka Stern"]', '{"Rivka Stern":{"name":"Rivka Stern"}}', 'active', now() - interval '1 day');
UPDATE link_parent_invites SET person_ids_resolved_at = now() - interval '1 day'
 WHERE id = 'a6000000-aaaa-0000-0000-000000000007';
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a6000000-0000-0000-0000-000000000007', 'app1',
    '{"camperRoster":{"Rivka Stern":{"name":"Rivka Stern","camperId":1},"Ghost Kid":{"name":"Ghost Kid","camperId":3}}}');
UPDATE camp_state_kv SET value = '{"camperRoster":{"Rivka Stern":{"name":"Rivka Stern","camperId":1}}}'
 WHERE camp_id = 'a6000000-0000-0000-0000-000000000007' AND key = 'app1';
DO $$
DECLARE i uuid := 'a6000000-aaaa-0000-0000-000000000007';
BEGIN
    IF (SELECT person_ids FROM link_parent_invites WHERE id = i) IS DISTINCT FROM '[null]'::jsonb THEN
        RAISE EXCEPTION 'setup: %', (SELECT person_ids FROM link_parent_invites WHERE id = i);
    END IF;
    -- 131's UPDATE, with the number the Me page now sends.
    UPDATE link_parent_invites SET camper_names = '["Rivka Stern"]',
           camper_data = '{"Rivka Stern":{"name":"Rivka Stern","camperId":1}}'
     WHERE id = i;
    IF (SELECT person_ids FROM link_parent_invites WHERE id = i) IS DISTINCT FROM '[1]'::jsonb THEN
        RAISE EXCEPTION 'TED-018: the re-save did not fill the slot: %', (SELECT person_ids FROM link_parent_invites WHERE id = i);
    END IF;
END $$;
INSERT INTO link_parent_invites (id, camp_id, parent_email, camper_names, status)
VALUES ('a6000000-aaaa-0000-0000-000000000077', 'a6000000-0000-0000-0000-000000000007', 'new@260.test',
        '["Ghost Kid"]', 'active');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS 'SELECT ''a6000000-0000-0000-0000-0000000000a7''::uuid';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.restamp_parent_invite('a6000000-aaaa-0000-0000-000000000077');
    IF v -> 'now' <> '[null]'::jsonb THEN
        RAISE EXCEPTION 'TED-019: the repair gave a new family a departed child''s number: %', v;
    END IF;
END $$;
ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. (TED-011) A sibling removed and a child renamed in the same save: the
--    repair must never put the renamed child on the sibling's number.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;
INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000008', '260 camp eight');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload, deleted_at, first_seen, updated_at)
VALUES ('a6000000-0000-0000-0000-000000000008', 1, 'camper', 'Avi Gold', 'Avi Gold', false,
        '{"name":"Avi Gold","dob":"2014-01-01","parent1Email":"gold@x.test"}', '2026-07-01 10:00:00+00', '2026-06-01 10:00:00+00', '2026-07-01 10:00:00+00'),
       ('a6000000-0000-0000-0000-000000000008', 2, 'camper', 'Moshe Gold', 'Moshe Gold', false,
        '{"name":"Moshe Gold","dob":"2016-05-05","parent1Email":"gold@x.test"}', '2026-07-01 10:00:00+00', '2026-06-01 10:00:00+00', '2026-07-01 10:00:00+00'),
       ('a6000000-0000-0000-0000-000000000008', 3, 'camper', 'Moshe Gold-Stein', 'Moshe Gold-Stein', true,
        '{"name":"Moshe Gold-Stein","dob":"2016-05-05","parent1Email":"gold@x.test"}', NULL, '2026-07-01 10:00:00+00', '2026-07-01 10:00:00+00');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a6000000-0000-0000-0000-000000000008', 'app1',
    '{"camperRoster":{"Moshe Gold-Stein":{"name":"Moshe Gold-Stein","camperId":3,"dob":"2016-05-05"}}}');
INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('a6000000-0000-0000-0000-000000000008', 'Avi Gold', 1, 'Avi Gold', 80.00);
DO $$
DECLARE v jsonb; c uuid := 'a6000000-0000-0000-0000-000000000008';
BEGIN
    v := public.split_renames();
    IF jsonb_array_length(v -> 'split_children') <> 1 OR v #>> '{split_children,0,original_number}' <> '2' THEN
        RAISE EXCEPTION 'TED-011: Moshe is not matched to his own number only: %', v;
    END IF;
    v := public.split_renames(true);
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 2 AND source_key = 'Moshe Gold-Stein')
       OR NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 1 AND source_key = 'Avi Gold' AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'TED-011: the repair touched the sibling''s number: %', v;
    END IF;
END $$;
ROLLBACK;

-- Moshe's old record has no birthday and no email: nothing can say which of
-- the two children who left in that save he is. Left for a person.
BEGIN;
INSERT INTO camps (id, name) VALUES ('a6000000-0000-0000-0000-000000000008', '260 camp eight');
INSERT INTO camp_people (camp_id, person_id, kind, source_key, name, minted, payload, deleted_at, first_seen, updated_at)
VALUES ('a6000000-0000-0000-0000-000000000008', 1, 'camper', 'Avi Gold', 'Avi Gold', false,
        '{"name":"Avi Gold","parent1Email":"gold@x.test"}', '2026-07-01 10:00:00+00', '2026-06-01 10:00:00+00', '2026-07-01 10:00:00+00'),
       ('a6000000-0000-0000-0000-000000000008', 2, 'camper', 'Moshe Gold', 'Moshe Gold', false,
        '{"name":"Moshe Gold"}', '2026-07-01 10:00:00+00', '2026-06-01 10:00:00+00', '2026-07-01 10:00:00+00'),
       ('a6000000-0000-0000-0000-000000000008', 44, 'camper', 'Moshe Gold-Stone', 'Moshe Gold-Stone', true,
        '{"name":"Moshe Gold-Stone","parent1Email":"gold@x.test"}', NULL, '2026-07-01 10:00:00+00', '2026-07-01 10:00:00+00');
INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, balance)
VALUES ('a6000000-0000-0000-0000-000000000008', 'Avi Gold', 1, 'Avi Gold', 80.00);
DO $$
DECLARE v jsonb; c uuid := 'a6000000-0000-0000-0000-000000000008';
BEGIN
    v := public.split_renames(true);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'split_children') x
                WHERE x ->> 'split_number' = '44') THEN
        RAISE EXCEPTION 'TED-011: an uncertain match was repaired: %', v;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_people WHERE camp_id = c AND person_id = 44 AND deleted_at IS NULL)
       OR (SELECT balance FROM camp_canteen_accounts WHERE camp_id = c AND person_id = 1) <> 80 THEN
        RAISE EXCEPTION 'TED-011: the sibling''s number or money was taken: %', v;
    END IF;
    IF jsonb_array_length(v -> 'needs_a_person') < 1 THEN
        RAISE EXCEPTION 'the uncertain match is not shown to a person: %', v;
    END IF;
END $$;
ROLLBACK;
