-- Behaviour test for 226. The defect it fixes is a parent's withdrawal of
-- consent for facial recognition doing nothing, while reporting success, because
-- the child had been renamed. So the first thing here reproduces that exact
-- sequence and insists it now works.
--
--   1. Grant, upload, RENAME, withdraw — and every descriptor and tag is gone.
--      Under the old code they all survived under the old name.
--   2. A withdrawal that spans two spellings also purges the legacy `descriptor`
--      column on the row filed under the old name.
--   3. The repair: a leak manufactured directly is counted by a dry run, deleted
--      only when confirmed, and the verifier goes to zero.
--   4. promote_confirmed_face reads consent per PERSON: it works across a
--      rename, and it refuses after a withdrawal filed under a different name.
--   5. The ten-confirmed-faces cap counts per person, not per spelling.
--   6. resolve_photo_tag rejects a tag written under another name.
--   7. submit_link_tip refuses another family's child, still allows a tip that
--      names no camper, and still credits the staff account.
--   8. record_link_photo_purchase stamps the id, survives a rename, and is still
--      idempotent on the payment intent.
--   9. Granting consent purges nothing.
--  10. One overload each; 028's unchecked four-argument headshot is gone.
--  11. The residual hole is measured, not hidden: a face row with no person_id
--      whose name no longer resolves cannot be reached by person, and the
--      verifier's two counts are what shows how many of those exist.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;

-- A 128-float descriptor, the shape 029 insists on.
CREATE OR REPLACE FUNCTION public.t226_desc(seed numeric) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_agg(to_jsonb(seed + g)) FROM generate_series(1, 128) g
$$;


-- ── 10. one overload each, and the unchecked 028 headshot is gone ───────────
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.proname IN ('set_camper_face_consent', 'submit_camper_headshot',
                             'promote_confirmed_face', 'resolve_photo_tag',
                             'record_link_photo_purchase', 'submit_link_tip')
         GROUP BY p.proname
    LOOP
        IF r.c <> 1 THEN
            RAISE EXCEPTION 'public.% has % overloads', r.proname, r.c;
        END IF;
    END LOOP;
    -- 028's headshot predates every descriptor check in 029: no model check, no
    -- dimension check. It was reachable by a four-argument call.
    IF to_regprocedure('public.submit_camper_headshot(uuid,text,text,jsonb)') IS NOT NULL THEN
        RAISE EXCEPTION 'the unchecked 028 submit_camper_headshot is still callable';
    END IF;
    IF to_regprocedure('public.submit_link_tip(text,text,numeric,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'the 016 four-argument submit_link_tip is still callable';
    END IF;
    RAISE NOTICE '226: one overload each, and 028''s unchecked headshot function is gone';
END $$;


-- ── the camp, the roster, the parents ───────────────────────────────────────
DO $$
DECLARE
    camp  uuid := 'f2600000-0000-0000-0000-000000000001';
    owner uuid := 'f2600000-0000-0000-0000-0000000000ff';
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (camp, owner, 'Consent Camp');
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss', jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',  jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'),
            'Rina Gold',   jsonb_build_object('camperId', '882', 'name', 'Rina Gold'))));
    INSERT INTO camp_users (camp_id, user_id, role)
         VALUES (camp, 'f2600000-0000-0000-0000-00000000c0aa', 'admin');
END $$;

INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES
    ('f2600000-0000-0000-0000-000000000001', 'f2600000-0000-0000-0000-00000000c001',
     'Weiss parent', 'w@example.test', jsonb_build_array('Ayala Weiss'), 'active'),
    ('f2600000-0000-0000-0000-000000000001', 'f2600000-0000-0000-0000-00000000c002',
     'Lerner parent', 'l@example.test', jsonb_build_array('Dov Lerner'), 'active');

INSERT INTO link_photos (id, camp_id, file_name) VALUES
    ('f26aaaaa-0000-0000-0000-000000000001', 'f2600000-0000-0000-0000-000000000001', 'p1.jpg'),
    ('f26aaaaa-0000-0000-0000-000000000002', 'f2600000-0000-0000-0000-000000000001', 'p2.jpg');


-- ── 1, 2, 9. the leak, reproduced and closed ────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2600000-0000-0000-0000-000000000001';
    r    jsonb;
    n    bigint;
BEGIN
    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c001', false);

    -- The parent opts in and uploads three poses.
    r := public.set_camper_face_consent(camp, 'Ayala Weiss', true, NULL);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'consent grant refused: %', r; END IF;
    r := public.submit_camper_headshot(camp, 'Ayala Weiss', 'data:image/png;base64,AAA',
                                       public.t226_desc(1), 'front', 'faceapi-128', NULL);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'headshot refused: %', r; END IF;
    PERFORM public.submit_camper_headshot(camp, 'Ayala Weiss', NULL,
                                          public.t226_desc(2), 'left', 'faceapi-128', NULL);
    PERFORM public.submit_camper_headshot(camp, 'Ayala Weiss', NULL,
                                          public.t226_desc(3), 'right', 'faceapi-128', NULL);

    -- 9. granting purges nothing
    PERFORM public.set_camper_face_consent(camp, 'Ayala Weiss', true, NULL);
    IF (SELECT count(*) FROM link_camper_face_descriptors
         WHERE camp_id = camp AND person_id = 880) <> 3 THEN
        RAISE EXCEPTION 're-granting consent destroyed the reference photos';
    END IF;

    -- She is tagged in both photos.
    INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, confidence, pending) VALUES
        ('f26aaaaa-0000-0000-0000-000000000001', camp, 'Ayala Weiss', 0.9, false),
        ('f26aaaaa-0000-0000-0000-000000000002', camp, 'Ayala Weiss', 0.7, true);

    IF (SELECT count(*) FROM link_camper_face_descriptors
         WHERE camp_id = camp AND camper_name = 'Ayala Weiss') <> 3
       OR (SELECT count(*) FROM link_photo_tags
            WHERE camp_id = camp AND camper_name = 'Ayala Weiss') <> 2
       OR (SELECT descriptor FROM link_camper_faces
            WHERE camp_id = camp AND camper_name = 'Ayala Weiss') IS NULL THEN
        RAISE EXCEPTION 'the seed did not produce the biometric data the withdrawal must remove';
    END IF;

    -- THE RENAME. Her id does not move; the roster key does.
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Ayala Weiss'
                             || jsonb_build_object('Ayala Weiss-Katz',
                                  jsonb_build_object('camperId', '880',
                                                     'name', 'Ayala Weiss-Katz')))
     WHERE camp_id = camp AND key = 'app1';
    IF (SELECT person_id FROM camp_people
         WHERE camp_id = camp AND source_key = 'Ayala Weiss-Katz') IS DISTINCT FROM 880 THEN
        RAISE EXCEPTION 'the rename did not carry the id';
    END IF;
    -- The old spelling no longer resolves, which is what used to strand the data.
    IF public.camp_person_by_name(camp, 'Ayala Weiss') IS NOT NULL THEN
        RAISE EXCEPTION 'the old spelling still resolves — the leak cannot be reproduced';
    END IF;

    -- THE WITHDRAWAL, under the name the parent now sees.
    r := public.set_camper_face_consent(camp, 'Ayala Weiss-Katz', false, NULL);
    IF (r ->> 'success') <> 'true' OR (r ->> 'consent') <> 'false' THEN
        RAISE EXCEPTION 'the withdrawal was refused: %', r;
    END IF;

    -- 1. Every descriptor gone, under BOTH spellings.
    SELECT count(*) INTO n FROM link_camper_face_descriptors
     WHERE camp_id = camp
       AND (camper_name IN ('Ayala Weiss', 'Ayala Weiss-Katz') OR person_id = 880);
    IF n <> 0 THEN
        RAISE EXCEPTION '% face descriptors survived a withdrawal of consent — the parent was '
                        'told it succeeded', n;
    END IF;

    -- Every tag gone, approved and pending alike.
    SELECT count(*) INTO n FROM link_photo_tags
     WHERE camp_id = camp
       AND (camper_name IN ('Ayala Weiss', 'Ayala Weiss-Katz') OR person_id = 880);
    IF n <> 0 THEN
        RAISE EXCEPTION '% photo tags survived a withdrawal of consent', n;
    END IF;

    -- 2. And the legacy descriptor column on the row filed under the OLD name.
    SELECT count(*) INTO n FROM link_camper_faces
     WHERE camp_id = camp AND descriptor IS NOT NULL
       AND (camper_name IN ('Ayala Weiss', 'Ayala Weiss-Katz') OR person_id = 880);
    IF n <> 0 THEN
        RAISE EXCEPTION 'the 128-float descriptor is still on % face row(s) after a withdrawal', n;
    END IF;

    -- The consent DECISION is kept — it is the record that the parent said no.
    IF public.camper_face_consent(camp, 880) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'the withdrawal is not what a later read of consent reports: %',
                        public.camper_face_consent(camp, 880);
    END IF;
    -- Under every spelling, not just the one the parent used.
    IF EXISTS (SELECT 1 FROM link_camper_faces
                WHERE camp_id = camp AND person_id = 880 AND consent = true) THEN
        RAISE EXCEPTION 'a row for this child still says consent = true';
    END IF;

    RAISE NOTICE '226: a withdrawal after a rename now removes every descriptor, every tag and '
                 'the legacy column, under both spellings';
END $$;


-- ── 4, 5. promote_confirmed_face reads consent per person ───────────────────
DO $$
DECLARE
    camp uuid := 'f2600000-0000-0000-0000-000000000001';
    r    jsonb;
    i    integer;
    n    bigint;
BEGIN
    -- Ayala withdrew. Staff must not be able to keep teaching the model.
    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c0aa', false);
    r := public.promote_confirmed_face(camp, 'Ayala Weiss-Katz', public.t226_desc(9),
                                       'faceapi-128', NULL);
    IF (r ->> 'error') <> 'no_consent' THEN
        RAISE EXCEPTION 'a confirmed face was accepted for a child whose parent withdrew: %', r;
    END IF;
    -- And not under the old spelling either, which is the direction that used to
    -- work because the old row still said true.
    r := public.promote_confirmed_face(camp, 'Ayala Weiss', public.t226_desc(9),
                                       'faceapi-128', 880);
    IF (r ->> 'error') <> 'no_consent' THEN
        RAISE EXCEPTION 'the old spelling let staff keep learning a withdrawn child''s face: %', r;
    END IF;

    -- Dov's parent opts in, then Dov is renamed. Consent must still be found.
    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c002', false);
    PERFORM public.set_camper_face_consent(camp, 'Dov Lerner', true, NULL);
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Dov Lerner'
                             || jsonb_build_object('Dov L',
                                  jsonb_build_object('camperId', '881', 'name', 'Dov L')))
     WHERE camp_id = camp AND key = 'app1';

    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c0aa', false);
    r := public.promote_confirmed_face(camp, 'Dov L', public.t226_desc(10), 'faceapi-128', NULL);
    IF (r ->> 'success') <> 'true' THEN
        RAISE EXCEPTION 'a rename made a consenting child look like a non-consenting one: %', r;
    END IF;

    -- 5. The cap counts per PERSON.
    --
    -- Calling the function twice with the two spellings would NOT prove this:
    -- it derives the label from the id, so both calls write 'Dov L' and a
    -- per-spelling count would agree with a per-person one. The rows that make
    -- the two answers differ are ones already on file under the old spelling,
    -- from before the rename — so six of those are seeded directly, and then six
    -- more are promoted through the function. Ten per spelling would keep all
    -- twelve; ten per person keeps ten.
    FOR i IN 1..6 LOOP
        INSERT INTO link_camper_face_descriptors
            (camp_id, camper_name, person_id, model, pose, source, descriptor, created_at)
        VALUES (camp, 'Dov Lerner', 881, 'faceapi-128', 'confirmed', 'confirmed',
                public.t226_desc(200 + i), now() - (i || ' hours')::interval);
    END LOOP;
    FOR i IN 1..6 LOOP
        PERFORM public.promote_confirmed_face(camp, 'Dov L', public.t226_desc(100 + i),
                                              'faceapi-128', NULL);
    END LOOP;
    SELECT count(*) INTO n FROM link_camper_face_descriptors
     WHERE camp_id = camp AND source = 'confirmed' AND model = 'faceapi-128'
       AND (person_id = 881 OR camper_name IN ('Dov L', 'Dov Lerner'));
    IF n > 10 THEN
        RAISE EXCEPTION 'the confirmed-face cap kept % rows for one child — it is counting per '
                        'spelling, not per person', n;
    END IF;
    RAISE NOTICE '226: consent is read per person across a rename, refused after a withdrawal, '
                 'and the confirmed cap holds % rows for one child', n;
END $$;


-- ── 6. a tag rejection reaches a tag written under another name ─────────────
DO $$
DECLARE
    camp uuid := 'f2600000-0000-0000-0000-000000000001';
    r    jsonb;
BEGIN
    -- Written under the OLD spelling while it still resolved, so 223's trigger
    -- stamped the id. person_id is set explicitly here because the rename has
    -- already happened by this point in the test and the trigger would now find
    -- nothing — which is itself the residual hole measured at the end of this
    -- file, not the case under test here.
    INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, person_id, confidence, pending)
         VALUES ('f26aaaaa-0000-0000-0000-000000000001', camp, 'Dov Lerner', 881, 0.6, true);
    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c0aa', false);

    -- The office rejects it using the name it now sees.
    r := public.resolve_photo_tag('f26aaaaa-0000-0000-0000-000000000001', 'Dov L', false, NULL);
    IF (r ->> 'success') <> 'true' OR (r ->> 'rows')::bigint < 1 THEN
        RAISE EXCEPTION 'the rejection matched no rows: %', r;
    END IF;
    IF EXISTS (SELECT 1 FROM link_photo_tags
                WHERE photo_id = 'f26aaaaa-0000-0000-0000-000000000001'
                  AND (camper_name IN ('Dov L', 'Dov Lerner') OR person_id = 881)) THEN
        RAISE EXCEPTION 'a rejected tag survived under the name it was written with';
    END IF;

    -- Approval still works and stamps the id.
    INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, person_id, confidence, pending)
         VALUES ('f26aaaaa-0000-0000-0000-000000000002', camp, 'Dov Lerner', 881, 0.95, true);
    r := public.resolve_photo_tag('f26aaaaa-0000-0000-0000-000000000002', NULL, true, 881);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'approval refused: %', r; END IF;
    IF EXISTS (SELECT 1 FROM link_photo_tags
                WHERE photo_id = 'f26aaaaa-0000-0000-0000-000000000002' AND pending = true) THEN
        RAISE EXCEPTION 'an approved tag is still pending';
    END IF;

    -- A photo nobody owns, and a stranger, both refused.
    IF (public.resolve_photo_tag('f26aaaaa-0000-0000-0000-00000000dead', 'Dov L', false, NULL)
        ->> 'error') <> 'photo_not_found' THEN
        RAISE EXCEPTION 'a missing photo did not refuse';
    END IF;
    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c001', false);
    IF (public.resolve_photo_tag('f26aaaaa-0000-0000-0000-000000000001', 'Dov L', false, NULL)
        ->> 'error') <> 'not_a_member' THEN
        RAISE EXCEPTION 'a parent resolved a photo tag';
    END IF;
    RAISE NOTICE '226: a tag rejection reaches the row whatever name it was written under';
END $$;


-- ── 7. submit_link_tip ──────────────────────────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2600000-0000-0000-0000-000000000001';
    r    jsonb;
BEGIN
    PERFORM set_config('test.uid', 'f2600000-0000-0000-0000-00000000c002', false);

    -- Another family's child, by id and by name.
    r := public.submit_link_tip('Counselor R', 'Counselor', 20, NULL, camp::text, 880);
    IF (r ->> 'error') <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a tip was filed against another family''s child by id: %', r;
    END IF;
    r := public.submit_link_tip('Counselor R', 'Counselor', 20, 'Ayala Weiss-Katz', camp::text, NULL);
    IF (r ->> 'error') <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a tip was filed against another family''s child by name: %', r;
    END IF;

    -- Their own child, by id, after a rename.
    r := public.submit_link_tip('Counselor R', 'Counselor', 25, NULL, camp::text, 881);
    IF (r ->> 'success') <> 'true' OR (r ->> 'camper_id') <> '881' THEN
        RAISE EXCEPTION 'a tip for the parent''s own child was refused: %', r;
    END IF;
    IF (SELECT camper_name FROM link_tips WHERE id = (r ->> 'id')::uuid) IS DISTINCT FROM 'Dov L' THEN
        RAISE EXCEPTION 'the tip was not labelled with the current roster key';
    END IF;

    -- A tip that names no camper is still allowed — thanking a counsellor is not
    -- about one child.
    r := public.submit_link_tip('Counselor R', 'Counselor', 10, NULL, camp::text, NULL);
    IF (r ->> 'success') <> 'true' THEN
        RAISE EXCEPTION 'a tip naming no camper was refused: %', r;
    END IF;

    -- And the staff account carries all three credits.
    IF (SELECT balance FROM link_staff_accounts
         WHERE camp_id = camp AND lower(staff_name) = 'counselor r') IS DISTINCT FROM 35.00 THEN
        RAISE EXCEPTION 'the staff credit is %, expected 35.00 from 25 + 10',
            (SELECT balance FROM link_staff_accounts
              WHERE camp_id = camp AND lower(staff_name) = 'counselor r');
    END IF;

    -- The amount guards still bite.
    IF (public.submit_link_tip('Counselor R', 'Counselor', 0.5, NULL, camp::text, NULL)
        ->> 'error') <> 'invalid_amount'
       OR (public.submit_link_tip('Counselor R', 'Counselor', 501, NULL, camp::text, NULL)
        ->> 'error') <> 'invalid_amount' THEN
        RAISE EXCEPTION 'the tip amount limits stopped biting';
    END IF;
    RAISE NOTICE '226: tips refuse another family''s child, allow a camper-less tip, and still '
                 'credit the staff account';
END $$;


-- ── 8. record_link_photo_purchase ───────────────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2600000-0000-0000-0000-000000000001';
    r    jsonb;
BEGIN
    -- Called by the webhook with the name the checkout carried.
    r := public.record_link_photo_purchase(camp, 'f2600000-0000-0000-0000-00000000c002',
            'facial_recognition', 'Dov L', NULL, 1500, 'pi_226_a', NULL);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'purchase refused: %', r; END IF;
    IF (SELECT person_id FROM link_photo_purchases WHERE stripe_payment_intent_id = 'pi_226_a')
       IS DISTINCT FROM 881 THEN
        RAISE EXCEPTION 'a purchase did not record the camper id';
    END IF;

    -- A checkout that carried a name the roster has since changed cannot produce
    -- an id — there is nothing to resolve. The record must still be written:
    -- money has moved, and a webhook that drops the row because a name went
    -- stale loses the evidence of a payment. This is the residual hole, and the
    -- right behaviour in the face of it.
    r := public.record_link_photo_purchase(camp, 'f2600000-0000-0000-0000-00000000c002',
            'facial_recognition', 'Dov Lerner', NULL, 1500, 'pi_226_stale', NULL);
    IF (r ->> 'success') <> 'true'
       OR NOT EXISTS (SELECT 1 FROM link_photo_purchases
                       WHERE stripe_payment_intent_id = 'pi_226_stale') THEN
        RAISE EXCEPTION 'a purchase under a stale name was lost: %', r;
    END IF;
    IF (SELECT person_id FROM link_photo_purchases
         WHERE stripe_payment_intent_id = 'pi_226_stale') IS NOT NULL THEN
        RAISE EXCEPTION 'a stale name invented a camper id';
    END IF;

    -- By id, with no usable name: the label comes from the roster.
    r := public.record_link_photo_purchase(camp, 'f2600000-0000-0000-0000-00000000c002',
            'facial_recognition', NULL, NULL, 1500, 'pi_226_b', 881);
    IF (SELECT camper_name FROM link_photo_purchases WHERE stripe_payment_intent_id = 'pi_226_b')
       IS DISTINCT FROM 'Dov L' THEN
        RAISE EXCEPTION 'the purchase was not labelled from the roster';
    END IF;

    -- A retried webhook must not charge twice.
    PERFORM public.record_link_photo_purchase(camp, 'f2600000-0000-0000-0000-00000000c002',
            'facial_recognition', 'Dov L', NULL, 1500, 'pi_226_a', NULL);
    IF (SELECT count(*) FROM link_photo_purchases
         WHERE stripe_payment_intent_id = 'pi_226_a') <> 1 THEN
        RAISE EXCEPTION 'a retried webhook recorded the purchase twice';
    END IF;

    -- An id that names nobody must NOT lose the record: the money already moved.
    r := public.record_link_photo_purchase(camp, 'f2600000-0000-0000-0000-00000000c002',
            'facial_recognition', 'Someone Unknown', NULL, 1500, 'pi_226_c', 999999);
    IF (r ->> 'success') <> 'true'
       OR (SELECT camper_name FROM link_photo_purchases
            WHERE stripe_payment_intent_id = 'pi_226_c') IS DISTINCT FROM 'Someone Unknown' THEN
        RAISE EXCEPTION 'a webhook with an unresolvable id lost the record of a payment: %', r;
    END IF;
    RAISE NOTICE '226: a purchase records the camper id, survives a rename, and a retry still '
                 'records once';
END $$;


-- ── 3, 11. the repair, and the residual hole measured ───────────────────────
DO $$
DECLARE
    camp uuid := 'f2600000-0000-0000-0000-000000000001';
    r    jsonb;
    v    jsonb;
BEGIN
    -- Manufacture exactly what the old code left behind for Rina: biometric data
    -- under her old name, and a later withdrawal filed under her new one.
    INSERT INTO link_camper_faces
        (camp_id, camper_name, person_id, descriptor, consent, updated_at)
    VALUES (camp, 'Rina Gold', 882, public.t226_desc(50), true, now() - interval '2 days');
    INSERT INTO link_camper_face_descriptors
        (camp_id, camper_name, person_id, model, pose, source, descriptor)
    VALUES (camp, 'Rina Gold', 882, 'faceapi-128', 'front', 'parent', public.t226_desc(50));
    INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, person_id, confidence)
    VALUES ('f26aaaaa-0000-0000-0000-000000000001', camp, 'Rina Gold', 882, 0.8);
    -- The withdrawal, under a different spelling, written later.
    INSERT INTO link_camper_faces
        (camp_id, camper_name, person_id, consent, updated_at)
    VALUES (camp, 'Rina Goldberg', 882, false, now());

    IF public.camper_face_consent(camp, 882) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'the latest instruction for Rina does not read as a withdrawal';
    END IF;

    -- 3. The dry run counts and deletes nothing.
    r := public.purge_revoked_face_data();
    IF (r ->> 'dry_run') <> 'true' OR (r ->> 'deleted') <> 'false' THEN
        RAISE EXCEPTION 'the no-argument form claims to have deleted: %', r;
    END IF;
    IF (r ->> 'campers_whose_withdrawal_was_not_honoured')::bigint <> 1 THEN
        RAISE EXCEPTION 'the dry run counted % leaked campers, expected 1: %',
                        r ->> 'campers_whose_withdrawal_was_not_honoured', r;
    END IF;
    IF (SELECT count(*) FROM link_camper_face_descriptors
         WHERE camp_id = camp AND person_id = 882) <> 1 THEN
        RAISE EXCEPTION 'the DRY RUN deleted biometric data';
    END IF;

    v := public.verify_face_consent();
    IF (v ->> 'campers_whose_withdrawal_was_not_honoured')::bigint <> 1 THEN
        RAISE EXCEPTION 'the verifier and the dry run disagree: % vs 1',
                        v ->> 'campers_whose_withdrawal_was_not_honoured';
    END IF;
    IF (v ->> 'campers_with_face_rows_under_two_names')::bigint < 1 THEN
        RAISE EXCEPTION 'the verifier cannot see Rina''s two rows: %', v;
    END IF;
    IF (v ->> 'campers_whose_two_rows_disagree_about_consent')::bigint < 1 THEN
        RAISE EXCEPTION 'the verifier cannot see the disagreement: %', v;
    END IF;

    -- And now for real.
    r := public.purge_revoked_face_data(true);
    IF (r ->> 'deleted') <> 'true' OR (r ->> 'campers_purged')::bigint <> 1 THEN
        RAISE EXCEPTION 'the confirmed purge did nothing: %', r;
    END IF;
    IF (SELECT count(*) FROM link_camper_face_descriptors
         WHERE camp_id = camp AND person_id = 882) <> 0
       OR (SELECT count(*) FROM link_photo_tags WHERE camp_id = camp AND person_id = 882) <> 0
       OR EXISTS (SELECT 1 FROM link_camper_faces
                   WHERE camp_id = camp AND person_id = 882 AND descriptor IS NOT NULL) THEN
        RAISE EXCEPTION 'the confirmed purge left biometric data behind';
    END IF;

    v := public.verify_face_consent();
    IF (v ->> 'campers_whose_withdrawal_was_not_honoured')::bigint <> 0 THEN
        RAISE EXCEPTION 'the verifier still reports a leak after the repair: %', v;
    END IF;

    -- 11. The residual hole, measured rather than hidden. A face row written
    --     before 223 whose name no longer resolves carries no person_id, so no
    --     amount of person-scoped purging can reach it. The verifier's two
    --     counts are what makes that visible; a camp with a non-zero gap has
    --     rows only a human can match up.
    INSERT INTO link_camper_faces (camp_id, camper_name, person_id, descriptor, consent)
    VALUES (camp, 'Long Gone Camper', NULL, public.t226_desc(70), true);
    v := public.verify_face_consent();
    IF (v ->> 'face_rows')::bigint <= (v ->> 'face_rows_carrying_an_id')::bigint THEN
        RAISE EXCEPTION 'the verifier cannot show a row with no id, so the residual hole is '
                        'invisible: %', v;
    END IF;
    RAISE NOTICE '226: the leak is counted by a dry run, removed only when confirmed, and the '
                 'rows no id can reach are reported rather than hidden';
END $$;

RESET test.uid;
