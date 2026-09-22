-- Behaviour test for 225. Five functions were rewritten and five live functions
-- were dropped, so there are two different ways this ships broken: a submission
-- that now goes to the wrong child, and a submission that no longer works at all.
--
--   1. 224's cases still hold after the gate was refactored into row scope.
--      A refactor that quietly changed who a parent's children are would be the
--      worst outcome here, and it would not show up in any of 225's own tests.
--   2. Each of the five files a row carrying person_id.
--   3. An id and a MISMATCHED name: the row is filed under the id's label. The
--      name beside an id is not trusted.
--   4. An id for another family's child is refused, by id.
--   5. 'child_3' — what the portal has actually been sending — is treated as
--      absent, not as camper 3.
--   6. Exactly one overload of each name survives, and the 015 six-argument
--      camper-mail function with no camp scoping is gone.
--   7. camper mail still enforces camp_connected, the program gate and the
--      daily limit.
--   8. a form re-submitted after a rename supersedes the old row.
--   9. inbound email reports whether it resolved, and files under the roster key.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.camp_reader(p_camp_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT true $$;


-- ── 6. one overload each, and the dangerous one is gone ─────────────────────
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.proname IN ('submit_health_document', 'submit_pickup_request',
                             'submit_camper_mail', 'submit_link_form_response',
                             '_camper_mail_record')
         GROUP BY p.proname
    LOOP
        IF r.c <> 1 THEN
            RAISE EXCEPTION 'public.% has % overloads — a caller can still reach an old body',
                            r.proname, r.c;
        END IF;
    END LOOP;

    -- Named explicitly, because this is the one with teeth: 015's six-argument
    -- camper mail has no camp scoping, no camp_connected check and no program
    -- gate, and it was reachable until this file.
    IF to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'the 015 six-argument submit_camper_mail is still callable';
    END IF;
    IF to_regprocedure('public.submit_pickup_request(text,text,jsonb,text,uuid)') IS NOT NULL THEN
        RAISE EXCEPTION 'the 025 five-argument submit_pickup_request is still callable';
    END IF;
    -- And the ones that must still be there.
    IF to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text,text,bigint)') IS NULL
       OR to_regprocedure('public.submit_health_document(uuid,text,text,text,text,text,bigint)') IS NULL
       OR to_regprocedure('public.submit_pickup_request(text,text,jsonb,text,uuid,date,bigint)') IS NULL THEN
        RAISE EXCEPTION 'the drop took a signature this file was supposed to keep';
    END IF;
    RAISE NOTICE '225: one overload each, and the unscoped 015 camper-mail function is gone';
END $$;


-- ── 6b. the drop is exercised, not just observed ────────────────────────────
-- The check above passes trivially here: this harness applies 216-225, so
-- migrations 013, 015, 025 and 041 never ran and their overloads were never
-- created. Deleting the DROP from the migration therefore changed nothing and
-- the claim went untested — which is the same shape as the bug 225 is fixing.
--
-- So: create a stale overload with the exact signature 015 left behind, and
-- re-apply the real migration file. A body that answers 'i-am-the-old-one'
-- makes it unmistakable which function a six-argument call reaches.
-- TWO of them, because 225 removes overloads in two ways and each needs its own
-- proof. The six-argument form is on the file's named DROP list. The
-- two-argument form is not on any list, and is only reached by the catalog
-- sweep — the half that covers a signature nobody remembered.
CREATE OR REPLACE FUNCTION public.submit_camper_mail(
    p_camper_name text, p_subject text DEFAULT '', p_body text DEFAULT '',
    p_division text DEFAULT NULL, p_grade text DEFAULT NULL, p_bunk text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT jsonb_build_object('success', true, 'reached', 'i-am-the-old-one') $$;

CREATE OR REPLACE FUNCTION public.submit_camper_mail(p_camper_name text, p_body text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$ SELECT jsonb_build_object('success', true, 'reached', 'nobody-listed-me') $$;

DO $$
BEGIN
    IF to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text)') IS NULL
       OR to_regprocedure('public.submit_camper_mail(text,text)') IS NULL THEN
        RAISE EXCEPTION 'the stale overloads were not created — 6b would prove nothing';
    END IF;
END $$;

\i migrations/225_parent_submissions_run_on_ids.sql

DO $$
BEGIN
    IF to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'a six-argument submit_camper_mail survived the migration — that is a '
                        'function with no camp scoping, no camp_connected check and no program '
                        'gate, reachable by anyone who omits an argument';
    END IF;
    IF to_regprocedure('public.submit_camper_mail(text,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'an overload that is on no named DROP list survived — the catalog sweep '
                        'is not doing the job the named drops cannot do';
    END IF;
    IF to_regprocedure('public.submit_camper_mail(text,text,text,text,text,text,text,bigint)') IS NULL THEN
        RAISE EXCEPTION 'the drop took the current signature too';
    END IF;
    RAISE NOTICE '225: a stale overload planted before the migration is gone after it';
END $$;


-- ── the camp, two families, and a same-named pair ───────────────────────────
DO $$
DECLARE
    camp  uuid := 'f2500000-0000-0000-0000-000000000001';
    owner uuid := 'f2500000-0000-0000-0000-0000000000ff';
BEGIN
    INSERT INTO camps (id, owner, name) VALUES (camp, owner, 'Submissions Camp');
    -- 'Malky Stein' and 'Malky Stein #102' are two children, keyed the way
    -- campistry_camper_identity.js keys a duplicate.
    INSERT INTO camp_state_kv (camp_id, key, value) VALUES (camp, 'app1', jsonb_build_object(
        'camperRoster', jsonb_build_object(
            'Ayala Weiss',       jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss'),
            'Dov Lerner',        jsonb_build_object('camperId', '881', 'name', 'Dov Lerner'),
            'Malky Stein',       jsonb_build_object('camperId', '101', 'name', 'Malky Stein'),
            'Malky Stein #102',  jsonb_build_object('camperId', '102', 'name', 'Malky Stein #102',
                                                    'displayName', 'Malky Stein'))));
    IF (SELECT count(*) FROM camp_people WHERE camp_id = camp) <> 4 THEN
        RAISE EXCEPTION 'the roster did not project four campers';
    END IF;
END $$;

INSERT INTO link_parent_invites (camp_id, user_id, parent_name, parent_email, camper_names, status)
VALUES
    ('f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-00000000b001',
     'Weiss parent', 'weiss@example.test', jsonb_build_array('Ayala Weiss'), 'active'),
    ('f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-00000000b002',
     'Lerner parent', 'lerner@example.test', jsonb_build_array('Dov Lerner'), 'active'),
    -- Holds the SECOND Malky, the one with the suffixed key.
    ('f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-00000000b003',
     'Stein parent', 'stein@example.test', jsonb_build_array('Malky Stein #102'), 'active'),
    -- A parent holding both a camp-wide invite and a named one, to prove which
    -- invite a row gets filed against.
    ('f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-00000000b004',
     'Wildcard first', 'wild@example.test', NULL, 'active'),
    ('f2500000-0000-0000-0000-000000000001', 'f2500000-0000-0000-0000-00000000b004',
     'Named second', 'named@example.test', jsonb_build_array('Dov Lerner'), 'active');


-- ── 1. 224 still holds after the refactor ───────────────────────────────────
DO $$
DECLARE camp uuid := 'f2500000-0000-0000-0000-000000000001';
BEGIN
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b001', false);
    IF NOT public._parent_owns_camper(camp, 'Ayala Weiss')
       OR NOT public._parent_owns_person(camp, 880) THEN
        RAISE EXCEPTION 'the refactor broke the ordinary grant';
    END IF;
    IF public._parent_owns_camper(camp, 'Dov Lerner') OR public._parent_owns_person(camp, 881) THEN
        RAISE EXCEPTION 'the refactor granted another family''s child';
    END IF;

    -- The collision: 'Malky Stein' is the exact key of camper 101, so it is NOT
    -- ambiguous — it resolves to 101. The Stein parent holds 102, so asking by
    -- the bare display name reaches the WRONG child's id and must be refused.
    -- This is precisely why the portal has to send the id.
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b003', false);
    IF public._parent_owns_camper(camp, 'Malky Stein') THEN
        RAISE EXCEPTION 'the bare display name granted camper 101 to the parent of camper 102';
    END IF;
    IF NOT public._parent_owns_person(camp, 102) THEN
        RAISE EXCEPTION 'the Stein parent cannot reach their own child by id';
    END IF;

    -- A rename still carries.
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b001', false);
    UPDATE camp_state_kv
       SET value = jsonb_set(value - 'camperRoster',
                             '{camperRoster}', (value -> 'camperRoster') - 'Ayala Weiss'
                             || jsonb_build_object('Ayala Weiss-Katz',
                                  jsonb_build_object('camperId', '880', 'name', 'Ayala Weiss-Katz')))
     WHERE camp_id = camp AND key = 'app1';
    IF NOT public._parent_owns_camper(camp, 'Ayala Weiss-Katz') THEN
        RAISE EXCEPTION 'the refactor lost 224''s rename behaviour';
    END IF;

    -- And the wildcard.
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b004', false);
    IF NOT public._parent_owns_person(camp, 101) THEN
        RAISE EXCEPTION 'the refactor lost the camp-wide wildcard';
    END IF;
    RAISE NOTICE '225: 224''s grants, refusals, rename and wildcard all survive the refactor';
END $$;


-- ── 2, 3, 4. the five file rows against an id ───────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2500000-0000-0000-0000-000000000001';
    r    jsonb;
BEGIN
    -- ── submit_health_document, by id ───────────────────────────────────────
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b003', false);
    r := public.submit_health_document(camp, NULL, 'shots.pdf', 'application/pdf',
                                       repeat('x', 100), 'note', 102);
    IF (r ->> 'success') <> 'true' OR (r ->> 'camper_id') <> '102' THEN
        RAISE EXCEPTION 'a health document for the parent''s own child by id was refused: %', r;
    END IF;
    -- 3. the label came from the ROSTER, not from beside the id.
    IF (SELECT camper_name FROM link_health_submissions WHERE id = (r ->> 'id')::uuid)
       IS DISTINCT FROM 'Malky Stein #102'
       OR (SELECT person_id FROM link_health_submissions WHERE id = (r ->> 'id')::uuid)
       IS DISTINCT FROM 102 THEN
        RAISE EXCEPTION 'the row was not filed under the roster key for id 102: %',
            (SELECT jsonb_build_object('camper_name', camper_name, 'person_id', person_id)
               FROM link_health_submissions WHERE id = (r ->> 'id')::uuid);
    END IF;

    -- A mismatched name beside the id is ignored, not believed.
    r := public.submit_health_document(camp, 'Dov Lerner', 'again.pdf', 'application/pdf',
                                       repeat('x', 100), NULL, 102);
    IF (r ->> 'success') <> 'true' THEN
        RAISE EXCEPTION 'the id path was refused because of the name beside it: %', r;
    END IF;
    IF (SELECT camper_name FROM link_health_submissions WHERE id = (r ->> 'id')::uuid)
       IS DISTINCT FROM 'Malky Stein #102' THEN
        RAISE EXCEPTION 'a caller filed a row under one child''s id and another child''s name';
    END IF;

    -- 4. another family's child, by id
    r := public.submit_health_document(camp, NULL, 'no.pdf', 'application/pdf',
                                       repeat('x', 100), NULL, 881);
    IF (r ->> 'error') <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a parent filed a health document against another family''s child: %', r;
    END IF;
    -- an id that is not a camper at all
    r := public.submit_health_document(camp, NULL, 'no.pdf', 'application/pdf',
                                       repeat('x', 100), NULL, 999999);
    IF (r ->> 'error') <> 'unknown_camper' THEN
        RAISE EXCEPTION 'an id naming no camper was not refused: %', r;
    END IF;

    -- the name path still works, unchanged, for a parent whose name is unambiguous
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b002', false);
    r := public.submit_health_document(camp, 'Dov Lerner', 'd.pdf', 'application/pdf',
                                       repeat('x', 100));
    IF (r ->> 'success') <> 'true' OR (r ->> 'camper_id') <> '881' THEN
        RAISE EXCEPTION 'the name path stopped working: %', r;
    END IF;

    -- ── submit_pickup_request ───────────────────────────────────────────────
    r := public.submit_pickup_request('Early pickup', 'Dov Lerner', '{"childBunk":"B2"}'::jsonb,
                                      NULL, camp, NULL, NULL);
    IF (r ->> 'success') <> 'true'
       OR (SELECT person_id FROM parent_pickup_requests WHERE id = (r ->> 'id')::uuid)
          IS DISTINCT FROM 881 THEN
        RAISE EXCEPTION 'a pickup request did not record the camper id: %', r;
    END IF;
    r := public.submit_pickup_request('Early pickup', NULL, '{}'::jsonb, NULL, camp, NULL, 880);
    IF (r ->> 'error') <> 'camper_not_on_invite' THEN
        RAISE EXCEPTION 'a pickup request was filed against another family''s child: %', r;
    END IF;

    -- ── submit_camper_mail ─────────────────────────────────────────────────
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b003', false);
    r := public.submit_camper_mail(NULL, 'Hello', 'Have a great week', NULL, NULL, NULL,
                                  camp::text, 102);
    IF (r ->> 'success') <> 'true' THEN
        RAISE EXCEPTION 'camper mail by id was refused: %', r;
    END IF;
    IF (SELECT person_id FROM link_camper_mail WHERE id = (r ->> 'id')::uuid) IS DISTINCT FROM 102
       OR (SELECT camper_name FROM link_camper_mail WHERE id = (r ->> 'id')::uuid)
          IS DISTINCT FROM 'Malky Stein #102' THEN
        RAISE EXCEPTION 'camper mail was not filed against the id';
    END IF;
    -- A camp id that is not a uuid must refuse rather than widen the search.
    r := public.submit_camper_mail(NULL, 'Hi', 'body', NULL, NULL, NULL, 'not-a-uuid', 102);
    IF (r ->> 'error') <> 'bad_camp' THEN
        RAISE EXCEPTION 'a malformed camp id did not refuse: %', r;
    END IF;

    -- ── submit_link_form_response, and the child_3 landmine ────────────────
    -- 5. 'child_3' is what the portal has actually been sending. Digit
    --    extraction would read it as camper 3; it must be treated as absent so
    --    the name decides, exactly as it does today.
    IF public._camper_id_arg('child_3') IS NOT NULL
       OR public._camper_id_arg('child_0') IS NOT NULL
       OR public._camper_id_arg('') IS NOT NULL
       OR public._camper_id_arg('0') IS NOT NULL
       OR public._camper_id_arg(' 102 ') IS DISTINCT FROM 102 THEN
        RAISE EXCEPTION '_camper_id_arg is not strict: child_3 -> %, child_0 -> %, " 102 " -> %',
            public._camper_id_arg('child_3'), public._camper_id_arg('child_0'),
            public._camper_id_arg(' 102 ');
    END IF;

    r := public.submit_link_form_response('medical', 'Medical form', 'digital',
                                          'Malky Stein #102', 'child_3', '{"a":1}'::jsonb,
                                          NULL, NULL, NULL, NULL, NULL, NULL, camp::text, NULL);
    IF (r ->> 'success') <> 'true' OR (r ->> 'camper_id') <> '102' THEN
        RAISE EXCEPTION 'a form submitted with camper_id=child_3 did not fall back to the name: %', r;
    END IF;
    -- camper_id keeps the caller's value, because the admin page selects it;
    -- person_id beside it is the real one.
    IF (SELECT camper_id FROM link_form_responses WHERE id = (r ->> 'id')::uuid) <> 'child_3'
       OR (SELECT person_id FROM link_form_responses WHERE id = (r ->> 'id')::uuid)
          IS DISTINCT FROM 102 THEN
        RAISE EXCEPTION 'the form row did not carry both the legacy camper_id and the real one';
    END IF;

    RAISE NOTICE '225: all five file rows against an id, a mismatched name is ignored, '
                 'another family''s id is refused, and child_3 is not camper 3';
END $$;


-- ── 7. camper mail's other gates still bite ─────────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2500000-0000-0000-0000-000000000001';
    r    jsonb;
    i    integer;
BEGIN
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b002', false);

    -- the camp-wide program gate
    CREATE OR REPLACE FUNCTION public._link_program_enabled(p_camp_id uuid, p_program text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_catalog AS $f$ SELECT false $f$;
    r := public.submit_camper_mail('Dov Lerner', 'Hi', 'body', NULL, NULL, NULL, camp::text, NULL);
    IF (r ->> 'error') <> 'program_disabled' THEN
        RAISE EXCEPTION 'camper mail ignored the camp-wide program gate: %', r;
    END IF;
    CREATE OR REPLACE FUNCTION public._link_program_enabled(p_camp_id uuid, p_program text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_catalog AS $f$ SELECT true $f$;

    -- 122's disconnect
    UPDATE link_parent_invites SET camp_connected = false
     WHERE user_id = 'f2500000-0000-0000-0000-00000000b002';
    r := public.submit_camper_mail('Dov Lerner', 'Hi', 'body', NULL, NULL, NULL, camp::text, NULL);
    IF (r ->> 'error') <> 'camp_disconnected' THEN
        RAISE EXCEPTION 'camper mail ignored the camp disconnect: %', r;
    END IF;
    UPDATE link_parent_invites SET camp_connected = true
     WHERE user_id = 'f2500000-0000-0000-0000-00000000b002';

    -- the 25-a-day limit
    FOR i IN 1..25 LOOP
        r := public.submit_camper_mail('Dov Lerner', 'Hi', 'letter ' || i, NULL, NULL, NULL,
                                      camp::text, NULL);
        IF (r ->> 'success') <> 'true' THEN
            RAISE EXCEPTION 'letter % of 25 was refused: %', i, r;
        END IF;
    END LOOP;
    r := public.submit_camper_mail('Dov Lerner', 'Hi', 'one too many', NULL, NULL, NULL,
                                  camp::text, NULL);
    IF (r ->> 'error') <> 'daily_limit_reached' THEN
        RAISE EXCEPTION 'the 25-letter daily limit stopped biting: %', r;
    END IF;
    RAISE NOTICE '225: the program gate, the camp disconnect and the daily limit all still bite';
END $$;


-- ── 8. a form re-submitted after a rename replaces the old row ──────────────
DO $$
DECLARE
    camp uuid := 'f2500000-0000-0000-0000-000000000001';
    r    jsonb;
    n    bigint;
BEGIN
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b001', false);
    r := public.submit_link_form_response('waiver', 'Waiver', 'digital', 'Ayala Weiss-Katz',
                                          NULL, '{"v":1}'::jsonb, NULL, NULL, NULL, NULL, NULL,
                                          NULL, camp::text, NULL);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'first waiver refused: %', r; END IF;

    -- The camp renames her again. Her id does not move.
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{camperRoster}',
                             (value -> 'camperRoster') - 'Ayala Weiss-Katz'
                             || jsonb_build_object('A Weiss-Katz',
                                  jsonb_build_object('camperId', '880', 'name', 'A Weiss-Katz')))
     WHERE camp_id = camp AND key = 'app1';

    r := public.submit_link_form_response('waiver', 'Waiver', 'digital', 'A Weiss-Katz',
                                          NULL, '{"v":2}'::jsonb, NULL, NULL, NULL, NULL, NULL,
                                          NULL, camp::text, NULL);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'second waiver refused: %', r; END IF;

    SELECT count(*) INTO n FROM link_form_responses
     WHERE camp_id = camp AND form_id = 'waiver' AND person_id = 880;
    IF n <> 1 THEN
        RAISE EXCEPTION 'a rename left % waiver rows for one camper — the office would have to '
                        'choose between them', n;
    END IF;
    IF (SELECT answers FROM link_form_responses
         WHERE camp_id = camp AND form_id = 'waiver' AND person_id = 880)
       IS DISTINCT FROM '{"v":2}'::jsonb THEN
        RAISE EXCEPTION 'the surviving waiver is the stale one';
    END IF;
    RAISE NOTICE '225: a form re-submitted after a rename supersedes the old row by id';
END $$;


-- ── _parent_invite_for prefers the invite that names the child ──────────────
DO $$
DECLARE
    camp uuid := 'f2500000-0000-0000-0000-000000000001';
    r    jsonb;
    who  text;
BEGIN
    PERFORM set_config('test.uid', 'f2500000-0000-0000-0000-00000000b004', false);
    r := public.submit_pickup_request('Late', 'Dov Lerner', '{}'::jsonb, NULL, camp, NULL, NULL);
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'refused: %', r; END IF;
    SELECT parent_name INTO who FROM parent_pickup_requests WHERE id = (r ->> 'id')::uuid;
    IF who IS DISTINCT FROM 'Named second' THEN
        RAISE EXCEPTION 'the row was filed against the % invite instead of the one that names '
                        'the child', who;
    END IF;
    RAISE NOTICE '225: a row is filed against the invite that covers the child';
END $$;


-- ── 9. inbound email reports whether it resolved ────────────────────────────
DO $$
DECLARE
    camp uuid := 'f2500000-0000-0000-0000-000000000001';
    r    jsonb;
BEGIN
    -- A letter addressed in the wrong case must land with the same camper as one
    -- addressed correctly, not create a second correspondent.
    r := public._camper_mail_record(camp, 'fp-1', '  dov LERNER ', NULL, NULL, NULL,
                                    'A Parent', 'p@example.test', 'Hello', 'Dear Dov');
    IF (r ->> 'inserted') <> 'true' OR (r ->> 'camper_id') <> '881' THEN
        RAISE EXCEPTION 'inbound email did not resolve a fuzzy name: %', r;
    END IF;
    IF (SELECT camper_name FROM link_camper_mail WHERE id = (r ->> 'id')::uuid)
       IS DISTINCT FROM 'Dov Lerner' THEN
        RAISE EXCEPTION 'inbound email filed the letter under the sender''s spelling instead of '
                        'the roster key';
    END IF;

    -- A letter for somebody the roster cannot find is still recorded, and SAYS
    -- it could not be attributed.
    r := public._camper_mail_record(camp, 'fp-2', 'Unknown Child', NULL, NULL, NULL,
                                    'A Parent', 'p@example.test', 'Hello', 'Dear child');
    IF (r ->> 'inserted') <> 'true' THEN
        RAISE EXCEPTION 'an unresolvable letter was dropped: %', r;
    END IF;
    IF (r -> 'camper_id') <> 'null'::jsonb THEN
        RAISE EXCEPTION 'an unresolvable letter reported an id anyway: %', r;
    END IF;

    -- And the duplicate guard still works.
    r := public._camper_mail_record(camp, 'fp-1', 'Dov Lerner', NULL, NULL, NULL,
                                    'A Parent', 'p@example.test', 'Hello', 'Dear Dov');
    IF (r ->> 'duplicate') <> 'true' THEN
        RAISE EXCEPTION 'the inbound duplicate guard stopped working: %', r;
    END IF;
    RAISE NOTICE '225: inbound email files under the roster key, reports an unresolved name, '
                 'and still refuses a duplicate';
END $$;

RESET test.uid;
