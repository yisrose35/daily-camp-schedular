-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 256: faces, photo tags and form responses go by number.
--
-- Two children called Sam Cohen (#1 and #2), each with face data and a photo
-- tag filed under the same spelling but their own number. Withdrawing #1's
-- consent must remove #1's data and leave #2's alone. A row with no number,
-- under #1's name, still goes (the name fallback).
--
-- uuids are prefixed a5600000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO camps (id, name) VALUES ('a5600000-0000-0000-0000-000000000001', '256 camp');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5600000-0000-0000-0000-000000000001', 'app1',
  '{"camperRoster":{"Sam Cohen":{"name":"Sam Cohen","camperId":1},"Sam Cohen #2":{"name":"Sam Cohen","camperId":2}}}');

INSERT INTO link_photos (id, camp_id, file_name) VALUES
    ('a5600000-aaaa-0000-0000-000000000001', 'a5600000-0000-0000-0000-000000000001', 'p1.jpg'),
    ('a5600000-aaaa-0000-0000-000000000002', 'a5600000-0000-0000-0000-000000000001', 'p2.jpg'),
    ('a5600000-aaaa-0000-0000-000000000003', 'a5600000-0000-0000-0000-000000000001', 'p3.jpg');
INSERT INTO link_camper_face_descriptors (camp_id, camper_name, person_id, model, pose, source, descriptor)
VALUES ('a5600000-0000-0000-0000-000000000001', 'Sam Cohen', 1, 'm', 'front', 'parent', '[]'),
       ('a5600000-0000-0000-0000-000000000001', 'Sam Cohen', 2, 'm', 'front', 'parent', '[]');
INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, person_id, confidence, pending) VALUES
    ('a5600000-aaaa-0000-0000-000000000001', 'a5600000-0000-0000-0000-000000000001', 'Sam Cohen', 1, 0.9, false),
    ('a5600000-aaaa-0000-0000-000000000002', 'a5600000-0000-0000-0000-000000000001', 'Sam Cohen', 2, 0.9, false);
-- An old tag with no number, under #1's spelling.
ALTER TABLE link_photo_tags DISABLE TRIGGER trg_stamp_person_id;
INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, person_id, confidence, pending) VALUES
    ('a5600000-aaaa-0000-0000-000000000003', 'a5600000-0000-0000-0000-000000000001', 'Sam Cohen', NULL, 0.9, false);
ALTER TABLE link_photo_tags ENABLE TRIGGER trg_stamp_person_id;

DO $$
DECLARE c uuid := 'a5600000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
    IF public.verify_rows_matched_by_number() -> 'still_matching_rows_by_name_or_number' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'still matching by name or number: %', public.verify_rows_matched_by_number();
    END IF;

    v := public._purge_camper_face_data(c, 1);

    IF EXISTS (SELECT 1 FROM link_camper_face_descriptors WHERE camp_id = c AND person_id = 1)
       OR EXISTS (SELECT 1 FROM link_photo_tags WHERE camp_id = c AND person_id = 1) THEN
        RAISE EXCEPTION '#1''s face data survived their withdrawal';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM link_camper_face_descriptors WHERE camp_id = c AND person_id = 2)
       OR NOT EXISTS (SELECT 1 FROM link_photo_tags WHERE camp_id = c AND person_id = 2) THEN
        RAISE EXCEPTION 'withdrawing #1 deleted #2''s face data — the names matched: %', v;
    END IF;
    IF EXISTS (SELECT 1 FROM link_photo_tags WHERE camp_id = c AND person_id IS NULL) THEN
        RAISE EXCEPTION 'an old unnumbered tag under #1''s name was not removed';
    END IF;
END $$;

ROLLBACK;
