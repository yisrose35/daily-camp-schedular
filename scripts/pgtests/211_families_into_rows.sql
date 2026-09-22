-- Behaviour test for migration 211. Every check RAISEs on failure.
\set ON_ERROR_STOP on

INSERT INTO public.camps (id, owner, name)
VALUES ('77777777-7777-7777-7777-777777777777', NULL, 'Families Camp');

INSERT INTO public.camp_state_kv (camp_id, key, value) VALUES
('77777777-7777-7777-7777-777777777777', 'campistryMe', jsonb_build_object(
  'families', jsonb_build_object(
    'fk1', jsonb_build_object('name','Cohen','camperIds', jsonb_build_array('Ari Cohen'),
                              'charges', jsonb_build_array(
                                  jsonb_build_object('amount',100,'date','2026-06-01','description','Tuition'),
                                  jsonb_build_object('amount',25,'date','2026-06-02','description','Trip'))),
    'fk2', jsonb_build_object('name','Levy','camperIds', jsonb_build_array('Bina Levy','Chana Levy'),
                              'charges', jsonb_build_array(
                                  jsonb_build_object('amount',200,'date','2026-06-01','description','Tuition'))),
    'bad', '"not an object"'::jsonb)));

-- ── the trigger filled it on INSERT ───────────────────────────────────────
DO $$
DECLARE n integer; r jsonb;
BEGIN
    SELECT count(*) INTO n FROM camp_families
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND deleted_at IS NULL;
    IF n <> 2 THEN RAISE EXCEPTION 'expected 2 live families (the non-object skipped), got %', n; END IF;
    IF EXISTS (SELECT 1 FROM camp_families WHERE family_key = 'bad') THEN
        RAISE EXCEPTION 'a non-object families entry was projected';
    END IF;
    IF (SELECT name FROM camp_families WHERE family_key = 'fk1') <> 'Cohen' THEN
        RAISE EXCEPTION 'name was not extracted';
    END IF;
    IF (SELECT jsonb_array_length(camper_ids) FROM camp_families WHERE family_key = 'fk2') <> 2 THEN
        RAISE EXCEPTION 'camperIds were not extracted';
    END IF;
    r := public.verify_camp_families('77777777-7777-7777-7777-777777777777');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'out of sync after insert: %', r; END IF;
    IF (r ->> 'chargedInBlob')::numeric <> 325 THEN
        RAISE EXCEPTION 'charges should total 325, got %', r ->> 'chargedInBlob';
    END IF;
    IF (r ->> 'chargedInRows')::numeric <> (r ->> 'chargedInBlob')::numeric THEN
        RAISE EXCEPTION 'charge totals disagree: %', r;
    END IF;
    RAISE NOTICE 'ok  trigger on INSERT: 2 live families, non-object skipped, 325 charged both sides';
END $$;

-- ── editing one family does not disturb the other ─────────────────────────
DO $$
DECLARE t2_before timestamptz; t2_after timestamptz; r jsonb;
BEGIN
    SELECT updated_at INTO t2_before FROM camp_families WHERE family_key = 'fk2';
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{families,fk1,charges}',
               (value -> 'families' -> 'fk1' -> 'charges')
               || jsonb_build_array(jsonb_build_object('amount',50,'date','2026-06-05','description','Store'))),
           updated_at = now()
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND key = 'campistryMe';
    SELECT updated_at INTO t2_after FROM camp_families WHERE family_key = 'fk2';
    IF t2_after IS DISTINCT FROM t2_before THEN
        RAISE EXCEPTION 'editing fk1 rewrote fk2 (% -> %)', t2_before, t2_after;
    END IF;
    r := public.verify_camp_families('77777777-7777-7777-7777-777777777777');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'out of sync after an edit: %', r; END IF;
    IF (r ->> 'chargedInRows')::numeric <> 375 THEN
        RAISE EXCEPTION 'expected 375 charged after the edit, got %', r ->> 'chargedInRows';
    END IF;
    RAISE NOTICE 'ok  editing one family touches only that family row';
END $$;

-- ── a save that does not touch families changes nothing ───────────────────
DO $$
DECLARE before_ts timestamptz; after_ts timestamptz;
BEGIN
    SELECT max(updated_at) INTO before_ts FROM camp_families
     WHERE camp_id = '77777777-7777-7777-7777-777777777777';
    UPDATE camp_state_kv SET value = jsonb_set(value, '{campName}', '"Renamed"'::jsonb), updated_at = now()
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND key = 'campistryMe';
    SELECT max(updated_at) INTO after_ts FROM camp_families
     WHERE camp_id = '77777777-7777-7777-7777-777777777777';
    IF after_ts IS DISTINCT FROM before_ts THEN
        RAISE EXCEPTION 'an unrelated save rewrote family rows';
    END IF;
    RAISE NOTICE 'ok  an unrelated save costs one comparison and writes nothing';
END $$;

-- ── THE SOFT DELETE: a removed family is stamped, never destroyed ─────────
DO $$
DECLARE r jsonb; n integer; d timestamptz;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{families}', (value -> 'families') - 'fk2'), updated_at = now()
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND key = 'campistryMe';

    SELECT count(*) INTO n FROM camp_families
     WHERE camp_id = '77777777-7777-7777-7777-777777777777';
    IF n <> 2 THEN RAISE EXCEPTION 'the row was destroyed rather than stamped: % rows left', n; END IF;

    SELECT deleted_at INTO d FROM camp_families WHERE family_key = 'fk2';
    IF d IS NULL THEN RAISE EXCEPTION 'a removed family was not stamped deleted'; END IF;
    -- Its charges are still there, which is the whole point.
    IF (SELECT jsonb_array_length(payload -> 'charges') FROM camp_families WHERE family_key = 'fk2') <> 1 THEN
        RAISE EXCEPTION 'a soft-deleted family lost its charges';
    END IF;

    r := public.verify_camp_families('77777777-7777-7777-7777-777777777777');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'a soft delete must not read as out of sync: %', r; END IF;
    IF (r ->> 'softDeletedRows')::int <> 1 THEN RAISE EXCEPTION 'softDeletedRows should be 1: %', r; END IF;
    IF (r ->> 'liveRowsNotInDocument')::int <> 0 THEN
        RAISE EXCEPTION 'a stamped family must not count as live-but-absent: %', r;
    END IF;
    -- Charges now count the live family only.
    IF (r ->> 'chargedInRows')::numeric <> (r ->> 'chargedInBlob')::numeric THEN
        RAISE EXCEPTION 'charge totals disagree after a soft delete: %', r;
    END IF;
    RAISE NOTICE 'ok  a removed family is stamped, keeps its charges, and stays in sync';
END $$;

-- ── the stamp does not move on later saves ────────────────────────────────
DO $$
DECLARE d1 timestamptz; d2 timestamptz;
BEGIN
    SELECT deleted_at INTO d1 FROM camp_families WHERE family_key = 'fk2';
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{families,fk1,name}', '"Cohen-Gold"'::jsonb), updated_at = now()
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND key = 'campistryMe';
    SELECT deleted_at INTO d2 FROM camp_families WHERE family_key = 'fk2';
    IF d2 IS DISTINCT FROM d1 THEN
        RAISE EXCEPTION 'a later save rewrote an existing delete stamp (% -> %)', d1, d2;
    END IF;
    RAISE NOTICE 'ok  an existing delete stamp keeps its original time';
END $$;

-- ── A STALE SAVE IS UNDONE BY THE NEXT GOOD ONE ──────────────────────────
-- This is why absence is stamped rather than obeyed. A stale office tab saving
-- a document that has lost fk2 looks exactly like deleting fk2. Nothing was
-- destroyed, so putting it back restores it — charges and all.
DO $$
DECLARE r jsonb; d timestamptz;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{families,fk2}', jsonb_build_object(
               'name','Levy','camperIds', jsonb_build_array('Bina Levy','Chana Levy'),
               'charges', jsonb_build_array(jsonb_build_object('amount',200,'date','2026-06-01','description','Tuition')))),
           updated_at = now()
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND key = 'campistryMe';

    SELECT deleted_at INTO d FROM camp_families WHERE family_key = 'fk2';
    IF d IS NOT NULL THEN RAISE EXCEPTION 'a family that came back is still stamped deleted'; END IF;

    r := public.verify_camp_families('77777777-7777-7777-7777-777777777777');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'out of sync after a resurrection: %', r; END IF;
    IF (r ->> 'softDeletedRows')::int <> 0 THEN RAISE EXCEPTION 'the stamp was not cleared: %', r; END IF;
    IF (r ->> 'liveRows')::int <> 2 THEN RAISE EXCEPTION 'expected 2 live families again: %', r; END IF;
    IF (r ->> 'chargedInRows')::numeric <> (r ->> 'chargedInBlob')::numeric THEN
        RAISE EXCEPTION 'charges disagree after a resurrection: %', r;
    END IF;
    RAISE NOTICE 'ok  a stale save that dropped a family is undone by the next good save';
END $$;

-- ── the backfill does not resurrect what the document dropped ─────────────
DO $$
DECLARE d1 timestamptz; d2 timestamptz;
BEGIN
    UPDATE camp_state_kv
       SET value = jsonb_set(value, '{families}', (value -> 'families') - 'fk2'), updated_at = now()
     WHERE camp_id = '77777777-7777-7777-7777-777777777777' AND key = 'campistryMe';
    SELECT deleted_at INTO d1 FROM camp_families WHERE family_key = 'fk2';
    IF d1 IS NULL THEN RAISE EXCEPTION 'setup: fk2 should be stamped'; END IF;

    -- The migration's backfill shape, re-run. It must NOT clear deleted_at.
    INSERT INTO public.camp_families (camp_id, family_key, name, camper_ids, payload)
    SELECT kv.camp_id, f.key, COALESCE(f.value ->> 'name',''),
           CASE WHEN jsonb_typeof(f.value -> 'camperIds') = 'array'
                THEN f.value -> 'camperIds' ELSE '[]'::jsonb END, f.value
      FROM camp_state_kv kv
      CROSS JOIN LATERAL jsonb_each(
             CASE WHEN jsonb_typeof(kv.value -> 'families') = 'object'
                  THEN kv.value -> 'families' ELSE '{}'::jsonb END) AS f(key, value)
     WHERE kv.key = 'campistryMe' AND jsonb_typeof(f.value) = 'object'
       AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
    ON CONFLICT (camp_id, family_key) DO UPDATE
       SET name = EXCLUDED.name, camper_ids = EXCLUDED.camper_ids,
           payload = EXCLUDED.payload, updated_at = now();

    SELECT deleted_at INTO d2 FROM camp_families WHERE family_key = 'fk2';
    IF d2 IS DISTINCT FROM d1 THEN
        RAISE EXCEPTION 're-running the backfill disturbed a delete stamp (% -> %)', d1, d2;
    END IF;
    RAISE NOTICE 'ok  re-pasting the file does not resurrect a family the document dropped';
END $$;

-- ── a camp with no families at all ───────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
    INSERT INTO public.camps (id, owner, name)
    VALUES ('88888888-8888-8888-8888-888888888888', NULL, 'No Families');
    INSERT INTO public.camp_state_kv (camp_id, key, value)
    VALUES ('88888888-8888-8888-8888-888888888888', 'campistryMe', '{}'::jsonb);
    r := public.verify_camp_families('88888888-8888-8888-8888-888888888888');
    IF (r ->> 'inSync') <> 'true' THEN RAISE EXCEPTION 'empty camp not in sync: %', r; END IF;
    IF (r ->> 'blobFamilies')::int <> 0 OR (r ->> 'liveRows')::int <> 0 THEN
        RAISE EXCEPTION 'empty camp should have nothing: %', r;
    END IF;
    RAISE NOTICE 'ok  a camp with no families verifies clean';
END $$;

SELECT 'ALL 211 BEHAVIOUR CHECKS PASSED' AS result;
