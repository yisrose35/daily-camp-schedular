-- ============================================================================
-- Migration 029: Facial Recognition v2 — multi-descriptor enrollment,
-- quality-gated review queue, and confirmed-tag gallery growth.
--
-- Builds on migration 028. Research-backed changes (see FACE_RECOGNITION_V2.md):
--   * MULTI-DESCRIPTOR ENROLLMENT — parents upload up to 3 pose-diverse photos
--     (front / left / right) instead of one; each descriptor is stored in the
--     new link_camper_face_descriptors table. The matcher aggregates them into
--     a mean template (AWS Rekognition "user vector" prior art).
--   * MULTI-MODEL — descriptors carry a model tag ('faceapi-128' legacy 128-D,
--     'arc-512' InsightFace 512-D). The two vector spaces are incompatible and
--     are never cross-matched.
--   * REVIEW QUEUE — link_photo_tags.pending: gray-zone matches are stored but
--     NOT visible to parents until staff confirm them.
--   * GALLERY GROWTH — promote_confirmed_face() lets staff-confirmed matches
--     feed back into the camper's descriptor gallery (capped) so recognition
--     improves over the summer.
--
-- Consent model is unchanged: everything remains gated on link_camper_faces
-- .consent, and revoking consent now also purges the v2 descriptor rows.
-- ============================================================================

-- ─── 1. link_camper_face_descriptors — N descriptors per camper ──────────────
CREATE TABLE IF NOT EXISTS public.link_camper_face_descriptors (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    camper_name  text        NOT NULL,
    model        text        NOT NULL DEFAULT 'faceapi-128',  -- 'faceapi-128' | 'arc-512'
    pose         text        NOT NULL DEFAULT 'front',        -- 'front' | 'left' | 'right' | 'extra' | 'confirmed'
    source       text        NOT NULL DEFAULT 'parent',       -- 'parent' | 'confirmed'
    descriptor   jsonb       NOT NULL,
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.link_camper_face_descriptors ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_lcfd_camp_camper
    ON public.link_camper_face_descriptors (camp_id, camper_name);
-- one descriptor per (camper, model, pose) for parent uploads — re-upload replaces
CREATE UNIQUE INDEX IF NOT EXISTS idx_lcfd_parent_pose
    ON public.link_camper_face_descriptors (camp_id, camper_name, model, pose)
    WHERE source = 'parent';

DO $$
BEGIN
    DROP POLICY IF EXISTS lcfd_staff_all ON public.link_camper_face_descriptors;
    CREATE POLICY lcfd_staff_all ON public.link_camper_face_descriptors FOR ALL
        USING (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_camper_face_descriptors.camp_id AND u.user_id = auth.uid())
        )
        WITH CHECK (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_camper_face_descriptors.camp_id AND u.user_id = auth.uid())
        );
END $$;

-- ─── 2. link_photo_tags.pending — review-queue state ─────────────────────────
ALTER TABLE public.link_photo_tags ADD COLUMN IF NOT EXISTS pending boolean NOT NULL DEFAULT false;

-- ─── 3. submit_camper_headshot v2 — pose + model aware ────────────────────────
-- Replaces the 028 four-arg version (dropped to avoid PostgREST overload
-- ambiguity). Old clients calling with four args still resolve here via the
-- defaulted parameters.
DROP FUNCTION IF EXISTS public.submit_camper_headshot(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION public.submit_camper_headshot(
    p_camp_id       uuid,
    p_camper_name   text,
    p_headshot_data text,
    p_descriptor    jsonb,
    p_pose          text DEFAULT 'front',
    p_model         text DEFAULT 'faceapi-128'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    want_dims int;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT public._parent_owns_camper(p_camp_id, p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;
    IF p_pose NOT IN ('front','left','right','extra') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_pose');
    END IF;
    want_dims := CASE p_model WHEN 'faceapi-128' THEN 128 WHEN 'arc-512' THEN 512 ELSE NULL END;
    IF want_dims IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_model');
    END IF;
    IF p_descriptor IS NULL OR jsonb_array_length(p_descriptor) <> want_dims THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_descriptor');
    END IF;
    IF p_headshot_data IS NOT NULL AND length(p_headshot_data) > 1500000 THEN   -- ~1.1MB base64 ceiling
        RETURN jsonb_build_object('success', false, 'error', 'bad_headshot');
    END IF;

    -- consent row: uploading a reference photo IS opting in. The FRONT pose's
    -- 128-D descriptor also lands on the legacy column for back-compat.
    INSERT INTO link_camper_faces (camp_id, camper_name, descriptor, headshot_data, consent, consent_by, consent_at, updated_at)
    VALUES (p_camp_id, p_camper_name,
            CASE WHEN p_pose = 'front' AND p_model = 'faceapi-128' THEN p_descriptor END,
            CASE WHEN p_pose = 'front' THEN p_headshot_data END,
            true, caller, now(), now())
    ON CONFLICT (camp_id, camper_name) DO UPDATE
        SET descriptor    = CASE WHEN p_pose = 'front' AND p_model = 'faceapi-128'
                                 THEN EXCLUDED.descriptor ELSE link_camper_faces.descriptor END,
            headshot_data = CASE WHEN p_pose = 'front' AND EXCLUDED.headshot_data IS NOT NULL
                                 THEN EXCLUDED.headshot_data ELSE link_camper_faces.headshot_data END,
            consent       = true,
            consent_by    = caller,
            consent_at    = COALESCE(link_camper_faces.consent_at, now()),
            updated_at    = now();

    -- v2 descriptor row: replace the same (model, pose) parent upload
    DELETE FROM link_camper_face_descriptors
        WHERE camp_id = p_camp_id AND camper_name = p_camper_name
          AND model = p_model AND pose = p_pose AND source = 'parent';
    INSERT INTO link_camper_face_descriptors (camp_id, camper_name, model, pose, source, descriptor, created_by)
    VALUES (p_camp_id, p_camper_name, p_model, p_pose, 'parent', p_descriptor, caller);

    RETURN jsonb_build_object('success', true, 'pose', p_pose, 'model', p_model);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_camper_headshot(uuid, text, text, jsonb, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_camper_headshot(uuid, text, text, jsonb, text, text) TO authenticated;

-- ─── 4. set_camper_face_consent — revoke also purges v2 descriptors ──────────
CREATE OR REPLACE FUNCTION public.set_camper_face_consent(
    p_camp_id     uuid,
    p_camper_name text,
    p_consent     boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT public._parent_owns_camper(p_camp_id, p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO link_camper_faces (camp_id, camper_name, consent, consent_by, consent_at, updated_at)
    VALUES (p_camp_id, p_camper_name, p_consent, caller, CASE WHEN p_consent THEN now() END, now())
    ON CONFLICT (camp_id, camper_name) DO UPDATE
        SET consent    = p_consent,
            consent_by = caller,
            consent_at = CASE WHEN p_consent THEN now() ELSE NULL END,
            -- revoking consent purges the biometric data
            descriptor    = CASE WHEN p_consent THEN link_camper_faces.descriptor    ELSE NULL END,
            headshot_data = CASE WHEN p_consent THEN link_camper_faces.headshot_data ELSE NULL END,
            updated_at = now();

    IF NOT p_consent THEN
        DELETE FROM link_photo_tags WHERE camp_id = p_camp_id AND camper_name = p_camper_name;
        DELETE FROM link_camper_face_descriptors WHERE camp_id = p_camp_id AND camper_name = p_camper_name;
    END IF;

    RETURN jsonb_build_object('success', true, 'consent', p_consent);
END;
$$;

-- ─── 5. get_camp_face_index v2 — all descriptors per consented camper ─────────
-- Shape: faces: [{camper_name, descriptors: [{descriptor, model, pose, source}]}]
-- Legacy 028 rows (descriptor on link_camper_faces with no v2 rows) are folded
-- in as a 'front'/'parent' faceapi-128 descriptor so old enrollments keep working.
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
        'descriptors', sub.descriptors
    )), '[]'::jsonb)
    INTO result
    FROM (
        SELECT f.camper_name,
               (
                   SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'descriptor', d.descriptor,
                       'model',      d.model,
                       'pose',       d.pose,
                       'source',     d.source
                   )), '[]'::jsonb)
                   FROM link_camper_face_descriptors d
                   WHERE d.camp_id = f.camp_id AND d.camper_name = f.camper_name
               )
               ||
               -- legacy single descriptor, only when no v2 front/parent row exists
               CASE WHEN f.descriptor IS NOT NULL AND NOT EXISTS (
                        SELECT 1 FROM link_camper_face_descriptors d2
                        WHERE d2.camp_id = f.camp_id AND d2.camper_name = f.camper_name
                          AND d2.model = 'faceapi-128' AND d2.pose = 'front' AND d2.source = 'parent'
                    )
                    THEN jsonb_build_array(jsonb_build_object(
                        'descriptor', f.descriptor, 'model', 'faceapi-128',
                        'pose', 'front', 'source', 'parent'))
                    ELSE '[]'::jsonb
               END AS descriptors
        FROM link_camper_faces f
        WHERE f.camp_id = p_camp_id AND f.consent = true
    ) sub
    WHERE jsonb_array_length(sub.descriptors) > 0;

    RETURN jsonb_build_object('success', true, 'faces', result);
END;
$$;

-- ─── 6. promote_confirmed_face — staff-confirmed match grows the gallery ─────
-- Called when staff approve a review-queue suggestion (or manually tag a
-- detected face). Capped at 10 confirmed descriptors per (camper, model);
-- the oldest is evicted. Consent is re-checked — a camper who opted out
-- can never accumulate descriptors.
CREATE OR REPLACE FUNCTION public.promote_confirmed_face(
    p_camp_id     uuid,
    p_camper_name text,
    p_descriptor  jsonb,
    p_model       text DEFAULT 'faceapi-128'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    want_dims int;
    n_confirmed int;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM link_camper_faces f
        WHERE f.camp_id = p_camp_id AND f.camper_name = p_camper_name AND f.consent = true
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_consent');
    END IF;
    want_dims := CASE p_model WHEN 'faceapi-128' THEN 128 WHEN 'arc-512' THEN 512 ELSE NULL END;
    IF want_dims IS NULL OR p_descriptor IS NULL OR jsonb_array_length(p_descriptor) <> want_dims THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_descriptor');
    END IF;

    INSERT INTO link_camper_face_descriptors (camp_id, camper_name, model, pose, source, descriptor, created_by)
    VALUES (p_camp_id, p_camper_name, p_model, 'confirmed', 'confirmed', p_descriptor, caller);

    -- evict oldest confirmed rows beyond the cap
    SELECT count(*) INTO n_confirmed
    FROM link_camper_face_descriptors
    WHERE camp_id = p_camp_id AND camper_name = p_camper_name
      AND model = p_model AND source = 'confirmed';
    IF n_confirmed > 10 THEN
        DELETE FROM link_camper_face_descriptors
        WHERE id IN (
            SELECT id FROM link_camper_face_descriptors
            WHERE camp_id = p_camp_id AND camper_name = p_camper_name
              AND model = p_model AND source = 'confirmed'
            ORDER BY created_at ASC
            LIMIT n_confirmed - 10
        );
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.promote_confirmed_face(uuid, text, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.promote_confirmed_face(uuid, text, jsonb, text) TO authenticated;

-- ─── 7. save_scanned_photo — honor per-tag pending flag ──────────────────────
CREATE OR REPLACE FUNCTION public.save_scanned_photo(
    p_camp_id    uuid,
    p_image_data text,
    p_file_name  text,
    p_week       text,
    p_tags       jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    new_id   uuid := gen_random_uuid();
    rec      jsonb;
    n_tags   int  := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF p_image_data IS NULL OR length(p_image_data) > 4000000 THEN   -- ~3MB base64 ceiling
        RETURN jsonb_build_object('success', false, 'error', 'bad_image');
    END IF;

    INSERT INTO link_photos (id, camp_id, image_data, file_name, week, uploaded_by, faces_found)
    VALUES (new_id, p_camp_id, p_image_data, p_file_name, p_week, caller,
            coalesce(jsonb_array_length(p_tags), 0));

    FOR rec IN SELECT * FROM jsonb_array_elements(coalesce(p_tags, '[]'::jsonb)) LOOP
        -- only persist tags for consented campers
        IF EXISTS (
            SELECT 1 FROM link_camper_faces f
            WHERE f.camp_id = p_camp_id AND f.camper_name = rec->>'camper_name' AND f.consent = true
        ) THEN
            INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, confidence, manual, pending)
            VALUES (new_id, p_camp_id, rec->>'camper_name',
                    NULLIF(rec->>'confidence','')::real,
                    coalesce((rec->>'manual')::boolean, false),
                    coalesce((rec->>'pending')::boolean, false))
            ON CONFLICT (photo_id, camper_name) DO NOTHING;
            n_tags := n_tags + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'photo_id', new_id, 'tags_saved', n_tags);
END;
$$;

-- ─── 8. resolve_photo_tag — staff approve/reject a pending suggestion ─────────
CREATE OR REPLACE FUNCTION public.resolve_photo_tag(
    p_photo_id    uuid,
    p_camper_name text,
    p_approve     boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_camp uuid;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    SELECT camp_id INTO v_camp FROM link_photos WHERE id = p_photo_id;
    IF v_camp IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'photo_not_found'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = v_camp AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = v_camp AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    IF p_approve THEN
        UPDATE link_photo_tags SET pending = false
        WHERE photo_id = p_photo_id AND camper_name = p_camper_name;
    ELSE
        DELETE FROM link_photo_tags
        WHERE photo_id = p_photo_id AND camper_name = p_camper_name AND pending = true;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_photo_tag(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_photo_tag(uuid, text, boolean) TO authenticated;

-- ─── 9. get_my_camper_photos — parents never see pending tags ─────────────────
CREATE OR REPLACE FUNCTION public.get_my_camper_photos(p_camp_id uuid, p_week text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT DISTINCT ON (p.id) jsonb_build_object(
            'id',         p.id,
            'image_data', p.image_data,
            'week',       p.week,
            'created_at', p.created_at,
            'camper',     t.camper_name
        ) AS x, p.id, p.created_at
        FROM link_photos p
        JOIN link_photo_tags t ON t.photo_id = p.id
        WHERE p.camp_id = p_camp_id
          AND (p_week IS NULL OR p.week = p_week)
          AND t.pending = false
          AND public._parent_owns_camper(p_camp_id, t.camper_name)
        ORDER BY p.id, p.created_at DESC
    ) sub;

    RETURN jsonb_build_object('success', true, 'photos', result);
END;
$$;

-- ─── 10. get_my_camper_face_status — expose per-pose enrollment coverage ──────
CREATE OR REPLACE FUNCTION public.get_my_camper_face_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'camper_name', f.camper_name,
        'consent',     f.consent,
        'has_face',    (f.descriptor IS NOT NULL OR EXISTS (
                            SELECT 1 FROM link_camper_face_descriptors d
                            WHERE d.camp_id = f.camp_id AND d.camper_name = f.camper_name
                              AND d.source = 'parent')),
        'headshot',    f.headshot_data,
        'poses',       (
            SELECT coalesce(jsonb_agg(DISTINCT d.pose), '[]'::jsonb)
            FROM link_camper_face_descriptors d
            WHERE d.camp_id = f.camp_id AND d.camper_name = f.camper_name
              AND d.source = 'parent'
        )
    )), '[]'::jsonb)
    INTO result
    FROM link_camper_faces f
    WHERE f.camp_id = p_camp_id
      AND public._parent_owns_camper(p_camp_id, f.camper_name);

    RETURN jsonb_build_object('success', true, 'campers', result);
END;
$$;

-- ============================================================================
-- Done. New parent flow: submit_camper_headshot(pose, model) × up to 3 poses ×
-- available models. Staff flow: get_camp_face_index (multi-descriptor),
-- save_scanned_photo (pending tags), resolve_photo_tag (review queue),
-- promote_confirmed_face (gallery growth).
-- ============================================================================
