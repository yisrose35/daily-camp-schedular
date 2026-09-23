-- ════════════════════════════════════════════════════════════════════════════
-- Behaviour test for 258: a parent sees only their OWN child.
--
-- "Avi Katz" #10 leaves with a health document, a face on file and photos.
-- A new "Avi Katz" enrols as #11. Each parent must get their own child's
-- documents, photos and face-recognition record, and nothing of the other's:
--   * health documents (and one from before numbers, found by name);
--   * face consent — granting AND withdrawing — lands on #11, not #10;
--   * the photo matcher neither merges #10's face into #11's nor tags with
--     a child who has left;
--   * the photo gallery, and which photos a parent may open;
--   * the post-acceptance form's Camper Mail code comes from #11's number.
--
-- uuids are prefixed a5800000-.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$fn$;

BEGIN;

INSERT INTO auth.users (id, email) VALUES
    ('a5800000-0000-0000-0000-0000000000aa', 'owner@258.test'),
    ('a5800000-0000-0000-0000-0000000000b1', 'old@258.test'),
    ('a5800000-0000-0000-0000-0000000000b2', 'new@258.test');
INSERT INTO camps (id, name, owner) VALUES
    ('a5800000-0000-0000-0000-000000000001', '258 camp', 'a5800000-0000-0000-0000-0000000000aa');
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5800000-0000-0000-0000-000000000001', 'app1',
    '{"camperRoster":{"Avi Katz":{"name":"Avi Katz","camperId":10}}}');
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, person_ids, status) VALUES
    ('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-0000000000b1', 'old@258.test', '["Avi Katz"]', '[10]', 'active');

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000b1"}';
SELECT public.submit_health_document('a5800000-0000-0000-0000-000000000001', 'Avi Katz', 'old-shots.pdf',
    'application/pdf', 'data:application/pdf;base64,AA', p_camper_id => 10);
RESET "request.jwt.claims";

-- He leaves; a new Avi Katz arrives and the server numbers him #11.
UPDATE camp_state_kv SET value = '{"camperRoster":{}}' WHERE camp_id = 'a5800000-0000-0000-0000-000000000001' AND key = 'app1';
UPDATE camp_state_kv SET value = '{"camperRoster":{"Avi Katz":{"name":"Avi Katz"}}}'
 WHERE camp_id = 'a5800000-0000-0000-0000-000000000001' AND key = 'app1';
INSERT INTO link_parent_invites (camp_id, user_id, parent_email, camper_names, person_ids, status) VALUES
    ('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-0000000000b2', 'new@258.test', '["Avi Katz"]', '[11]', 'active');
-- A document from before numbers, for the child who is here now.
INSERT INTO link_health_submissions (id, camp_id, camper_name, person_id, file_name, file_type, file_data, note)
VALUES (gen_random_uuid(), 'a5800000-0000-0000-0000-000000000001', 'Avi Katz', NULL, 'legacy.pdf', 'application/pdf', 'AA', '');

DO $$
BEGIN
    IF (SELECT person_id FROM camp_people WHERE camp_id = 'a5800000-0000-0000-0000-000000000001'
         AND source_key = 'Avi Katz' AND deleted_at IS NULL) IS DISTINCT FROM 11 THEN
        RAISE EXCEPTION 'setup: the new Avi Katz is not #11';
    END IF;
    IF public.verify_parent_reads_by_number() <> '[]'::jsonb THEN
        RAISE EXCEPTION 'parent reads still decided by name: %', public.verify_parent_reads_by_number();
    END IF;
END $$;

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000b2"}';
DO $$
DECLARE v jsonb; files text[];
BEGIN
    v := public.get_my_health_documents('a5800000-0000-0000-0000-000000000001');
    SELECT array_agg(d->>'file_name' ORDER BY d->>'file_name') INTO files FROM jsonb_array_elements(v->'documents') d;
    IF 'old-shots.pdf' = ANY(files) THEN
        RAISE EXCEPTION 'the new Avi''s parent was shown the departed Avi''s health document: %', v;
    END IF;
    IF files IS DISTINCT FROM ARRAY['legacy.pdf'] THEN
        RAISE EXCEPTION 'the new Avi''s parent should see only the document from before numbers: %', v;
    END IF;
END $$;

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000b1"}';
DO $$
DECLARE v jsonb; files text[];
BEGIN
    v := public.get_my_health_documents('a5800000-0000-0000-0000-000000000001');
    SELECT array_agg(d->>'file_name' ORDER BY d->>'file_name') INTO files FROM jsonb_array_elements(v->'documents') d;
    IF files IS NULL OR NOT ('old-shots.pdf' = ANY(files)) THEN
        RAISE EXCEPTION 'the departed Avi''s parent no longer sees their own child''s document: %', v;
    END IF;
END $$;

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_camp_health_documents('a5800000-0000-0000-0000-000000000001');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'documents') d
                    WHERE d->>'file_name' = 'old-shots.pdf' AND (d->>'person_id')::bigint = 10) THEN
        RAISE EXCEPTION 'the office''s list does not carry the document''s camper number: %', v;
    END IF;
END $$;
RESET "request.jwt.claims";

-- Face recognition: the departed #10 gave consent and a headshot. The new
-- #11's parent's consent — and withdrawal — must land on #11, not #10; #10's
-- face must not tag today's photos, nor be merged into #11's reference.
-- #10's face was given while he was here: filed directly, as 256 would have.
INSERT INTO link_camper_faces (camp_id, camper_name, person_id, consent, updated_at)
VALUES ('a5800000-0000-0000-0000-000000000001', 'Avi Katz', 10, true, now() - interval '1 day');
INSERT INTO link_camper_face_descriptors (camp_id, camper_name, person_id, descriptor, model, pose, source)
SELECT 'a5800000-0000-0000-0000-000000000001', 'Avi Katz', 10, (SELECT jsonb_agg(0.1) FROM generate_series(1,128)), 'faceapi-128', 'front', 'parent';

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000b2"}';
DO $$
DECLARE c uuid := 'a5800000-0000-0000-0000-000000000001'; v jsonb;
BEGIN
    v := public.set_camper_face_consent(c, 'Avi Katz', true, 11);
    v := public.submit_camper_headshot(c, 'Avi Katz', 'data:image/png;base64,AA',
            (SELECT jsonb_agg(0.9) FROM generate_series(1,128)), p_camper_id => 11);
    IF (SELECT consent FROM link_camper_faces WHERE camp_id = c AND person_id = 11) IS NOT TRUE THEN
        RAISE EXCEPTION 'the new Avi''s consent was not filed on him: %',
            (SELECT jsonb_agg(to_jsonb(f) - 'descriptor' - 'headshot_data') FROM link_camper_faces f WHERE camp_id = c);
    END IF;
    v := public.set_camper_face_consent(c, 'Avi Katz', false, 11);
    IF (SELECT consent FROM link_camper_faces WHERE camp_id = c AND person_id = 10) IS NOT TRUE THEN
        RAISE EXCEPTION 'the new Avi''s parent withdrew consent for the departed Avi';
    END IF;
    IF (SELECT consent FROM link_camper_faces WHERE camp_id = c AND person_id = 11) IS NOT FALSE THEN
        RAISE EXCEPTION 'the new Avi''s withdrawal did not reach him';
    END IF;
    v := public.set_camper_face_consent(c, 'Avi Katz', true, 11);
    v := public.submit_camper_headshot(c, 'Avi Katz', 'data:image/png;base64,AA',
            (SELECT jsonb_agg(0.9) FROM generate_series(1,128)), p_camper_id => 11);
END $$;

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000aa"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_camp_face_index('a5800000-0000-0000-0000-000000000001');
    IF jsonb_array_length(v->'faces') <> 1 OR (v #>> '{faces,0,person_id}') IS DISTINCT FROM '11' THEN
        RAISE EXCEPTION 'the departed Avi still tags photos: %', v;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v #> '{faces,0,descriptors}') d
                WHERE (d->'descriptor'->>0)::numeric <> 0.9) THEN
        RAISE EXCEPTION 'the new Avi''s reference holds another child''s face: %', v #> '{faces,0,descriptors}';
    END IF;
END $$;
RESET "request.jwt.claims";

-- Photos: one of the departed #10, one of the new #11, both tagged "Avi Katz".
-- #11's parent has bought face-recognition photos for their child.
INSERT INTO link_photos (id, camp_id, file_name, week) VALUES
    ('a58aaaaa-0000-0000-0000-000000000010', 'a5800000-0000-0000-0000-000000000001', 'old.jpg', 'w1'),
    ('a58aaaaa-0000-0000-0000-000000000011', 'a5800000-0000-0000-0000-000000000001', 'new.jpg', 'w1');
INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, person_id, confidence, pending) VALUES
    ('a58aaaaa-0000-0000-0000-000000000010', 'a5800000-0000-0000-0000-000000000001', 'Avi Katz', 10, 0.9, false),
    ('a58aaaaa-0000-0000-0000-000000000011', 'a5800000-0000-0000-0000-000000000001', 'Avi Katz', 11, 0.9, false);
INSERT INTO link_photo_purchases (camp_id, parent_user_id, kind, camper_name, person_id, amount_paid_cents, stripe_payment_intent_id)
VALUES ('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-0000000000b2', 'facial_recognition', 'Avi Katz', 11, 500, 'pi_258_new'),
       ('a5800000-0000-0000-0000-000000000001', 'a5800000-0000-0000-0000-0000000000b1', 'facial_recognition', 'Avi Katz', 10, 500, 'pi_258_old');

SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000b2"}';
DO $$
DECLARE v jsonb; ids uuid[];
BEGIN
    v := public.get_my_camper_photos('a5800000-0000-0000-0000-000000000001');
    IF (SELECT array_agg(x->>'id') FROM jsonb_array_elements(v->'photos') x)
       IS DISTINCT FROM ARRAY['a58aaaaa-0000-0000-0000-000000000011'] THEN
        RAISE EXCEPTION 'the new Avi''s parent''s gallery is not just their own child: %', v;
    END IF;
    ids := public.get_viewable_photo_ids(ARRAY['a58aaaaa-0000-0000-0000-000000000010',
                                               'a58aaaaa-0000-0000-0000-000000000011']::uuid[]);
    IF ids IS DISTINCT FROM ARRAY['a58aaaaa-0000-0000-0000-000000000011']::uuid[] THEN
        RAISE EXCEPTION 'the new Avi''s parent may open the departed Avi''s photo: %', ids;
    END IF;
    -- The face card reports their own child's consent, which they withdrew
    -- and gave again above — not the departed child's.
    v := public.get_my_camper_face_status('a5800000-0000-0000-0000-000000000001');
    RAISE NOTICE '258 face status for #11''s parent: %', v;
END $$;
SET "request.jwt.claims" = '{"sub":"a5800000-0000-0000-0000-0000000000b1"}';
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_my_camper_photos('a5800000-0000-0000-0000-000000000001');
    IF (SELECT array_agg(x->>'id') FROM jsonb_array_elements(v->'photos') x)
       IS DISTINCT FROM ARRAY['a58aaaaa-0000-0000-0000-000000000010'] THEN
        RAISE EXCEPTION 'the departed Avi''s parent''s gallery is not just their own child: %', v;
    END IF;
END $$;
RESET "request.jwt.claims";

-- The post-acceptance form is told the application's own number, and the
-- Camper Mail code is built from it.
INSERT INTO camp_camper_mail_settings (camp_id, inbound_token, camp_number, enabled)
VALUES ('a5800000-0000-0000-0000-000000000001', 'tok258', '77', true);
INSERT INTO camp_state_kv (camp_id, key, value) VALUES ('a5800000-0000-0000-0000-000000000001', 'campistryMe',
    '{"roster":{"Avi Katz":{"camperId":10}},
      "enrollments":{"enr258":{"camperName":"Avi Katz","camperId":11,"status":"accepted"}}}')
ON CONFLICT (camp_id, key) DO UPDATE SET value = EXCLUDED.value;
DO $$
DECLARE v jsonb;
BEGIN
    v := public.get_postaccept_bootstrap('a5800000-0000-0000-0000-000000000001', 'enr258');
    IF (v->>'camperId') IS DISTINCT FROM '11' THEN
        RAISE EXCEPTION 'the form is not told the application''s number: %', v;
    END IF;
    IF (v #>> '{camperMail,camperCode}') IS DISTINCT FROM '77-11' THEN
        RAISE EXCEPTION 'the Camper Mail code came from another camper''s number: %', v -> 'camperMail';
    END IF;
END $$;

ROLLBACK;
