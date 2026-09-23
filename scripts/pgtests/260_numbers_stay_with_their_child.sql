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
