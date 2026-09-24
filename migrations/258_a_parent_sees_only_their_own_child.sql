-- ============================================================================
-- Migration 258: a parent sees only THEIR OWN child — decided by camper number.
--
-- THE CASE. A camper leaves. Next season a new child with the same name
-- enrols and gets a new camper number. Before this migration, everything
-- below went by the NAME, so the new child's parent was handed the departed
-- child's things, and the new child's own were filed on the departed child:
--
--   1. Health documents — the new child's parent saw the departed child's
--      shots, physicals and insurance cards (get_my_health_documents).
--   2. Photos — the new child's parent's gallery showed photos tagged with the
--      departed child, and could open them (get_my_camper_photos,
--      get_viewable_photo_ids, get_viewable_original_photo_ids).
--   3. Face recognition — the new child's parent's consent, and a WITHDRAWAL
--      of consent, was written on the departed child's face row: that table
--      held one row per NAME. The new child could not upload a front-facing
--      photo at all while the other's was on file.
--   4. The photo matcher merged both children's reference faces into one and
--      went on tagging new photos with a child who has left.
--   5. The post-acceptance form built a child's Camper Mail code from the
--      number found by name before the application's own number.
--
-- THE RULE, as everywhere since 248: a row with a number belongs to that
-- number. The name is used only for a row written before numbers.
--
-- Also: the office's health-document list carries each document's number.
--
-- HOW. Functions this file owns in full are replaced; the others are
-- rewritten in place, changing only the lines named, and the file stops with
-- a message if a function is not the text it expects. Safe to run twice.
--
-- Standalone. Paste into the Supabase SQL Editor and run. NOT part of
-- APPLY_BUNDLE.sql. Then run scripts/verify_identity_chain.sql: the 258 row
-- should read ok.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_health_documents(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'camper_name', s.camper_name, 'person_id', s.person_id, 'file_name', s.file_name,
        'status', s.status, 'created_at', s.created_at
    ) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_health_submissions s
    WHERE s.camp_id = p_camp_id
      AND CASE WHEN s.person_id IS NOT NULL
               THEN public._parent_owns_person(p_camp_id, s.person_id)
               ELSE public._parent_owns_camper(p_camp_id, s.camper_name) END;
    RETURN jsonb_build_object('success', true, 'documents', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_health_documents(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_health_documents(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_camp_health_documents(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'camper_name', s.camper_name, 'person_id', s.person_id, 'file_name', s.file_name,
        'file_type', s.file_type, 'file_data', s.file_data, 'note', s.note,
        'status', s.status, 'review_notes', s.review_notes,
        'reviewed_at', s.reviewed_at, 'created_at', s.created_at
    ) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_health_submissions s
    WHERE s.camp_id = p_camp_id;
    RETURN jsonb_build_object('success', true, 'documents', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_health_documents(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_health_documents(uuid) TO authenticated;

-- For scripts/verify_identity_chain.sql: parent read functions that still
-- decide ownership by a row's camper NAME alone. Should be empty.
CREATE OR REPLACE FUNCTION public.verify_parent_reads_by_number()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_agg(p.proname ORDER BY p.proname), '[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~ '_parent_owns_camper\s*\(\s*[^,]+,\s*[a-z_]+\.camper_name'
       AND p.prosrc !~ '_parent_owns_person\s*\(';
$$;
REVOKE ALL ON FUNCTION public.verify_parent_reads_by_number() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_parent_reads_by_number() TO authenticated, service_role;

-- ─── the post-acceptance form: the camper's code comes from their NUMBER ────
-- get_postaccept_bootstrap (209) built the Camper Mail code from the number
-- found by looking the camper's NAME up first, and the application's own
-- number second. The application's number goes first now, and the form is
-- told the number too. Rewritten in place: only these two lines change.
DO $$
DECLARE d text; n text;
BEGIN
    SELECT replace(pg_get_functiondef(p.oid), chr(13), '') INTO d
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'get_postaccept_bootstrap';
    IF d IS NULL THEN
        RAISE NOTICE '258: get_postaccept_bootstrap is not here — nothing to do';
        RETURN;
    END IF;
    IF d ~ 'enroll_row ->> ''camperId'',\s*kv_value #>>' THEN
        RETURN;                                   -- already applied
    END IF;
    n := regexp_replace(d,
        'kv_value #>> ARRAY\[''roster'', v_camper_nm, ''camperId''\],\s*enroll_row ->> ''camperId'',',
        'enroll_row ->> ''camperId'',
                kv_value #>> ARRAY[''roster'', v_camper_nm, ''camperId''],');
    n := regexp_replace(n,
        '''camperName'', coalesce\(enroll_row ->> ''camperName'', ''''\),',
        '''camperName'', coalesce(enroll_row ->> ''camperName'', ''''),
        ''camperId'', CASE WHEN (enroll_row ->> ''camperId'') ~ ''^\d+$'' THEN (enroll_row ->> ''camperId'')::bigint END,');
    IF n = d OR n !~ '''camperId'', CASE WHEN' OR n !~ 'enroll_row ->> ''camperId'',\s*kv_value #>>' THEN
        RAISE EXCEPTION '258: get_postaccept_bootstrap is not the 209 text this expects — send this message to the builder';
    END IF;
    EXECUTE n;
END $$;

-- ─── the photo matcher's face index goes by camper NUMBER ───────────────────
-- get_camp_face_index (030) gathered each child's reference faces by NAME:
--
--     FROM link_camper_face_descriptors d WHERE d.camper_name = f.camper_name
--
-- When a camper leaves and a new child with the same name enrols, both
-- children's faces were merged into one reference, and the departed child's
-- face went on tagging new photos with the new child's name — photos a
-- parent then sees of somebody else's child. Now:
--   * each child's faces are gathered by their number (by name only for a
--     row that has none);
--   * a camper who has left does not tag today's photos;
--   * the index carries each child's number, so tags are filed on it.
CREATE OR REPLACE FUNCTION public.get_camp_face_index(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'camper_name', sub.camper_name,
        'person_id',   sub.person_id,
        'descriptors', sub.descriptors
    )), '[]'::jsonb)
    INTO result
    FROM (
        SELECT f.camper_name, f.person_id,
               (
                   SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'descriptor', d.descriptor,
                       'model',      d.model,
                       'pose',       d.pose,
                       'source',     d.source,
                       'created_at', d.created_at
                   )), '[]'::jsonb)
                   FROM link_camper_face_descriptors d
                   WHERE d.camp_id = f.camp_id
                     AND CASE WHEN f.person_id IS NOT NULL AND d.person_id IS NOT NULL
                              THEN d.person_id = f.person_id
                              ELSE d.camper_name = f.camper_name END
               )
               ||
               -- legacy single descriptor, only when no v2 front/parent row exists
               CASE WHEN f.descriptor IS NOT NULL AND NOT EXISTS (
                        SELECT 1 FROM link_camper_face_descriptors d2
                        WHERE d2.camp_id = f.camp_id
                          AND CASE WHEN f.person_id IS NOT NULL AND d2.person_id IS NOT NULL
                                   THEN d2.person_id = f.person_id
                                   ELSE d2.camper_name = f.camper_name END
                          AND d2.model = 'faceapi-128' AND d2.pose = 'front' AND d2.source = 'parent'
                    )
                    THEN jsonb_build_array(jsonb_build_object(
                        'descriptor', f.descriptor, 'model', 'faceapi-128',
                        'pose', 'front', 'source', 'parent', 'created_at', f.updated_at))
                    ELSE '[]'::jsonb
               END AS descriptors
        FROM link_camper_faces f
        WHERE f.camp_id = p_camp_id AND f.consent = true
          -- a camper who has left is not in today's photos
          AND NOT EXISTS (SELECT 1 FROM camp_people cp
                           WHERE cp.camp_id = f.camp_id AND cp.kind = 'camper'
                             AND cp.person_id = f.person_id AND cp.deleted_at IS NOT NULL)
    ) sub
    WHERE jsonb_array_length(sub.descriptors) > 0;

    RETURN jsonb_build_object('success', true, 'faces', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_face_index(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_face_index(uuid) TO authenticated;

-- ─── one face row per CHILD, not per name ───────────────────────────────────
-- link_camper_faces was keyed PRIMARY KEY (camp_id, camper_name): one row per
-- NAME. When a camper leaves and a new child with the same name enrols, the
-- new child's parent's face-recognition consent — granting it, or WITHDRAWING
-- it — was written onto the departed child's row, and the new child never had
-- one. A parent's "no" to facial recognition landed on another child.
--
-- Now each camper number has its own row (a unique index on
-- (camp_id, person_id)); a row from before numbers keeps one per name. The
-- two functions that write the row — set_camper_face_consent and
-- submit_camper_headshot — upsert on the number, and keep the row's name
-- current. Rewritten in place: only their ON CONFLICT clauses change.
--
-- Rows already there: a child who was renamed can have two rows (226 explains
-- how). They are merged into the most recently updated one — that is the
-- parent's latest instruction, 226's rule — keeping a face descriptor from an
-- older row only where consent still stands.
DO $$
DECLARE r record; d text; n text; k int := 0;
BEGIN
    -- 1. merge duplicate rows of one child
    UPDATE link_camper_faces keep
       SET descriptor    = COALESCE(keep.descriptor, old.descriptor),
           headshot_data = COALESCE(keep.headshot_data, old.headshot_data)
      FROM (SELECT DISTINCT ON (camp_id, person_id) camp_id, person_id, descriptor, headshot_data
              FROM link_camper_faces
             WHERE person_id IS NOT NULL AND descriptor IS NOT NULL
             ORDER BY camp_id, person_id, updated_at DESC NULLS LAST) old
     WHERE keep.consent IS TRUE AND keep.camp_id = old.camp_id AND keep.person_id = old.person_id
       AND keep.ctid = (SELECT f.ctid FROM link_camper_faces f
                         WHERE f.camp_id = keep.camp_id AND f.person_id = keep.person_id
                         ORDER BY f.updated_at DESC NULLS LAST, f.camper_name LIMIT 1);
    DELETE FROM link_camper_faces f
     WHERE f.person_id IS NOT NULL
       AND f.ctid <> (SELECT g.ctid FROM link_camper_faces g
                       WHERE g.camp_id = f.camp_id AND g.person_id = f.person_id
                       ORDER BY g.updated_at DESC NULLS LAST, g.camper_name LIMIT 1);

    -- 2. the key: one row per number; one per name only for rows with none
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.link_camper_faces'::regclass
                  AND conname = 'link_camper_faces_pkey') THEN
        ALTER TABLE public.link_camper_faces DROP CONSTRAINT link_camper_faces_pkey;
    END IF;
    CREATE UNIQUE INDEX IF NOT EXISTS link_camper_faces_one_per_person
        ON public.link_camper_faces (camp_id, person_id) WHERE person_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS link_camper_faces_one_per_unnumbered_name
        ON public.link_camper_faces (camp_id, camper_name) WHERE person_id IS NULL;

    -- 3. the two writers upsert on the number
    FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname = 'public'
                AND p.proname IN ('set_camper_face_consent', 'submit_camper_headshot')
                AND p.prosrc ~ 'INSERT INTO link_camper_faces'
    LOOP
        d := replace(pg_get_functiondef(r.oid), chr(13), '');
        n := regexp_replace(d,
            '(INSERT INTO link_camper_faces[^;]*?)ON CONFLICT \(camp_id, camper_name\) DO UPDATE\s+SET ',
            '\1ON CONFLICT (camp_id, person_id) WHERE person_id IS NOT NULL DO UPDATE
            SET camper_name = EXCLUDED.camper_name, ', 'g');
        IF n <> d THEN EXECUTE n; k := k + 1; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.prosrc ~ 'INSERT INTO link_camper_faces'
                  AND p.prosrc ~ 'ON CONFLICT \(camp_id, camper_name\)') THEN
        RAISE EXCEPTION '258: a face writer still upserts by name — send this message to the builder';
    END IF;
END $$;

-- ─── a child's reference faces: one per pose per CHILD, not per name ────────
-- idx_lcfd_parent_pose (029) allowed one parent-uploaded face per pose per
-- NAME. A second child with the same name could not upload a front-facing
-- photo at all while the first child's was on file. Now it is one per pose per
-- child (by number), and per name only for rows with no number. A child
-- renamed before 258 can hold two for one pose; the newer is kept.
DO $$
BEGIN
    DELETE FROM link_camper_face_descriptors d
     WHERE d.source = 'parent' AND d.person_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM link_camper_face_descriptors e
                    WHERE e.camp_id = d.camp_id AND e.person_id = d.person_id
                      AND e.model = d.model AND e.pose = d.pose AND e.source = 'parent'
                      AND (e.created_at, e.id::text) > (d.created_at, d.id::text));
    DROP INDEX IF EXISTS public.idx_lcfd_parent_pose;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcfd_parent_pose_per_person
        ON public.link_camper_face_descriptors (camp_id, person_id, model, pose)
        WHERE source = 'parent' AND person_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lcfd_parent_pose_unnumbered
        ON public.link_camper_face_descriptors (camp_id, camper_name, model, pose)
        WHERE source = 'parent' AND person_id IS NULL;
END $$;

-- ─── what a parent sees of photos and faces, by camper NUMBER ───────────────
-- Four more parent reads decided "is this row my child's?" by the row's NAME:
--   get_my_camper_photos            — the parent's photo gallery
--   get_viewable_photo_ids          — may this parent open this photo
--   get_viewable_original_photo_ids — …and its full-resolution original
--   get_my_camper_face_status       — the face-recognition card
-- So the parent of a new child saw photos tagged with a departed child who
-- had the same name. The same rule as above, rewritten in place:
--
--     _parent_owns_camper(camp, t.camper_name)
--  →  CASE WHEN t.person_id IS NOT NULL THEN _parent_owns_person(camp, t.person_id)
--          ELSE _parent_owns_camper(camp, t.camper_name) END
--
-- and where two tables are joined on a camper, by number when both rows
-- have one (a photo purchase to its tag; a face to its reference photos).
DO $$
DECLARE r record; d text; n text;
BEGIN
    FOR r IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname = 'public'
                AND p.proname IN ('get_my_camper_photos', 'get_viewable_photo_ids',
                                  'get_viewable_original_photo_ids', 'get_my_camper_face_status')
                AND p.prosrc !~ '_parent_owns_person\s*\('
    LOOP
        d := replace(pg_get_functiondef(r.oid), chr(13), '');
        n := regexp_replace(d,
            '(public\.)?_parent_owns_camper\(\s*([a-z_.]+)\s*,\s*([a-z_]+)\.camper_name\s*\)',
            '(CASE WHEN \3.person_id IS NOT NULL THEN public._parent_owns_person(\2, \3.person_id) ELSE public._parent_owns_camper(\2, \3.camper_name) END)',
            'g');
        n := regexp_replace(n,
            '([a-z_]+)\.camper_name = ([a-z_]+)\.camper_name',
            '(CASE WHEN \1.person_id IS NOT NULL AND \2.person_id IS NOT NULL THEN \1.person_id = \2.person_id ELSE \1.camper_name = \2.camper_name END)',
            'g');
        IF n = d THEN
            RAISE EXCEPTION '258: % is not the text this expects — send this message to the builder', r.proname;
        END IF;
        EXECUTE n;
    END LOOP;
END $$;
