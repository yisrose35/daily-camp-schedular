-- Behaviour test for migration 200: applications are ROWS, one per applicant.
--
-- The question this answers, asked directly: does a family with three children
-- create THREE rows? The registration page makes one submit_public_application
-- call per camper ("siblings submit as separate enrollment entries"), and the
-- primary key is (camp_id, kind, entry_id), so it should. Proved rather than
-- assumed, including that a re-submit does not multiply them.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', NULL, 'Applications Camp');
-- No capacity configured: 0 or absent means unlimited, so nothing is waitlisted
-- and the row count is purely about one-row-per-applicant.
INSERT INTO public.camp_state_kv (camp_id, key, value)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'campistryMe', jsonb_build_object(
    'sessions', jsonb_build_array(jsonb_build_object('name','1st Half'))));

-- ── THREE SIBLINGS, THREE ROWS ─────────────────────────────────────────────
DO $$
DECLARE r jsonb; n integer; names text[];
BEGIN
    FOR i IN 1..3 LOOP
        r := public.submit_public_application(
               'cccccccc-cccc-cccc-cccc-cccccccccccc', 'enrollments',
               'lt_sibling_' || i || '_00000000000000000000000000',
               jsonb_build_object('camperName','Sibling ' || i,
                                  'parentName','One Parent',
                                  'parentEmail','parent@example.com',
                                  'session','1st Half','status','applied',
                                  'appliedDate','2026-03-01'));
        IF (r ->> 'success') <> 'true' THEN
            RAISE EXCEPTION 'sibling % was refused: %', i, r;
        END IF;
    END LOOP;

    SELECT count(*) INTO n FROM camp_applications
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND kind = 'enrollments';
    IF n <> 3 THEN RAISE EXCEPTION 'three children must be three rows, got %', n; END IF;

    SELECT array_agg(payload ->> 'camperName' ORDER BY payload ->> 'camperName') INTO names
      FROM camp_applications WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    IF names IS DISTINCT FROM ARRAY['Sibling 1','Sibling 2','Sibling 3'] THEN
        RAISE EXCEPTION 'each row must carry its own camper: %', names;
    END IF;
    RAISE NOTICE 'ok  three siblings from one parent become three separate rows';
END $$;

-- ── one parent, one email, still three distinct applicants ─────────────────
DO $$
DECLARE n integer;
BEGIN
    SELECT count(DISTINCT payload ->> 'parentEmail') INTO n
      FROM camp_applications WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    IF n <> 1 THEN RAISE EXCEPTION 'the three rows should share one parent email'; END IF;
    SELECT count(DISTINCT entry_id) INTO n
      FROM camp_applications WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    IF n <> 3 THEN RAISE EXCEPTION 'each applicant needs its own entry_id, got %', n; END IF;
    RAISE NOTICE 'ok  shared parent, distinct entry_id per applicant';
END $$;

-- ── a re-submit updates its own row, never adds one ───────────────────────
-- A family that hits Submit twice, or a flaky connection that retries, must not
-- produce a second application for the same child.
DO $$
DECLARE r jsonb; n integer;
BEGIN
    r := public.submit_public_application(
           'cccccccc-cccc-cccc-cccc-cccccccccccc', 'enrollments',
           'lt_sibling_2_00000000000000000000000000',
           jsonb_build_object('camperName','Sibling 2','parentName','One Parent',
                              'parentEmail','parent@example.com','session','1st Half',
                              'status','applied','appliedDate','2026-03-01',
                              'notes','corrected'));
    IF (r ->> 'success') <> 'true' THEN RAISE EXCEPTION 'a re-submit was refused: %', r; END IF;
    SELECT count(*) INTO n FROM camp_applications
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND kind = 'enrollments';
    IF n <> 3 THEN RAISE EXCEPTION 'a re-submit added a row: % rows', n; END IF;
    IF (SELECT payload ->> 'notes' FROM camp_applications
         WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
           AND entry_id = 'lt_sibling_2_00000000000000000000000000') <> 'corrected' THEN
        RAISE EXCEPTION 'the re-submit did not update its own row';
    END IF;
    RAISE NOTICE 'ok  a re-submit updates that applicant''s row and adds none';
END $$;

-- ── the camp document is never written by a submission ────────────────────
-- This is what lets hundreds of parents submit at once: no read-modify-write of
-- a shared row, so nobody queues behind anybody.
DO $$
DECLARE before_val jsonb; after_val jsonb;
BEGIN
    SELECT value INTO before_val FROM camp_state_kv
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND key = 'campistryMe';
    PERFORM public.submit_public_application(
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'enrollments',
        'lt_sibling_9_00000000000000000000000000',
        jsonb_build_object('camperName','Sibling 9','session','1st Half','status','applied'));
    SELECT value INTO after_val FROM camp_state_kv
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND key = 'campistryMe';
    IF after_val IS DISTINCT FROM before_val THEN
        RAISE EXCEPTION 'a submission modified the camp document — that is the bottleneck 200 removed';
    END IF;
    RAISE NOTICE 'ok  a submission never touches the camp document';
END $$;

-- ── staff applications are rows too, and are not places in a session ──────
DO $$
DECLARE n integer;
BEGIN
    PERFORM public.submit_public_application(
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'staffApplications',
        'lt_staff_1_000000000000000000000000000',
        jsonb_build_object('name','A Counselor','status','applied'));
    SELECT count(*) INTO n FROM camp_applications
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND kind = 'staffApplications';
    IF n <> 1 THEN RAISE EXCEPTION 'a staff application should be its own row'; END IF;
    -- the capacity index is partial on kind for exactly this reason
    SELECT count(*) INTO n FROM camp_applications
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' AND kind = 'enrollments';
    IF n <> 4 THEN RAISE EXCEPTION 'a staff application was counted as an enrollment'; END IF;
    RAISE NOTICE 'ok  staff applications are rows, and never count as a camper place';
END $$;

-- ── bad input is refused without creating anything ────────────────────────
DO $$
DECLARE n_before integer; n_after integer;
BEGIN
    SELECT count(*) INTO n_before FROM camp_applications
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    IF (public.submit_public_application('cccccccc-cccc-cccc-cccc-cccccccccccc',
          'enrollments', NULL, '{}'::jsonb) ->> 'error') <> 'invalid_payload' THEN
        RAISE EXCEPTION 'a null entry id must be refused';
    END IF;
    IF (public.submit_public_application('cccccccc-cccc-cccc-cccc-cccccccccccc',
          'somethingElse', 'lt_x_0000000000000000000000000000', '{}'::jsonb) ->> 'error')
       <> 'invalid_kind' THEN
        RAISE EXCEPTION 'an unknown kind must be refused';
    END IF;
    SELECT count(*) INTO n_after FROM camp_applications
     WHERE camp_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    IF n_after <> n_before THEN RAISE EXCEPTION 'a refused submission still created a row'; END IF;
    RAISE NOTICE 'ok  refused submissions create nothing';
END $$;

SELECT 'ALL 200 BEHAVIOUR CHECKS PASSED' AS result;
