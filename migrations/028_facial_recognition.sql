-- ============================================================================
-- Migration 028: Facial Recognition — cloud foundation
--
-- Turns the localStorage-only photo prototype (campistry_link_photos.js) into a
-- real, cloud-backed, parent-facing feature.
--
-- DESIGN
--   * Face descriptors are computed IN-BROWSER with face-api.js. No image is
--     ever sent anywhere for ML compute — only the resulting 128-float
--     descriptor (and a small headshot thumbnail) is persisted. Privacy-first.
--   * Per-family OPT-IN: a camper is only indexed/recognised after their parent
--     explicitly consents. get_camp_face_index() only returns consented faces,
--     so recognition physically cannot match a non-consented child.
--   * Parents reach these tables only through SECURITY DEFINER RPCs that validate
--     the camper is on the caller's invite (link_parent_invites.camper_names).
--   * Owner/staff read+write the tables directly (RLS policies below) because the
--     admin console authenticates as the camp owner/staff via CampistryDB.
--
--   Image bytes are stored base64 in-DB for now (resized small client-side).
--   TODO(scale): move gallery blobs to a private Supabase Storage bucket with a
--   tag-scoped SELECT policy once camps exceed a few thousand photos.
-- ============================================================================

-- ─── 1. link_camper_faces — reference index + consent (one row per camper) ────
CREATE TABLE IF NOT EXISTS public.link_camper_faces (
    camp_id        uuid        NOT NULL,
    camper_name    text        NOT NULL,
    descriptor     jsonb,                              -- 128-float array from face-api.js
    headshot_data  text,                               -- base64 data URL (small thumbnail)
    consent        boolean     NOT NULL DEFAULT false, -- parent opted in
    consent_by     uuid,                               -- parent user_id who granted
    consent_at     timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, camper_name)
);
ALTER TABLE public.link_camper_faces ENABLE ROW LEVEL SECURITY;

-- ─── 2. link_photos — gallery photo (metadata + image bytes) ──────────────────
CREATE TABLE IF NOT EXISTS public.link_photos (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    image_data   text,                                 -- base64 data URL (resized <=1200px)
    file_name    text,
    week         text,
    uploaded_by  uuid,
    faces_found  int         NOT NULL DEFAULT 0,
    sent         boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.link_photos ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_link_photos_camp_week ON public.link_photos (camp_id, week);

-- ─── 3. link_photo_tags — which camper appears in which photo ─────────────────
CREATE TABLE IF NOT EXISTS public.link_photo_tags (
    photo_id     uuid    NOT NULL REFERENCES public.link_photos(id) ON DELETE CASCADE,
    camp_id      uuid    NOT NULL,
    camper_name  text    NOT NULL,
    confidence   real,
    manual       boolean NOT NULL DEFAULT false,
    PRIMARY KEY (photo_id, camper_name)
);
ALTER TABLE public.link_photo_tags ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_link_photo_tags_camper ON public.link_photo_tags (camp_id, camper_name);

-- ─── 4. RLS: owner + staff (camp_users) get direct access; parents use RPCs ────
-- Helper predicate inlined per policy: caller owns the camp OR is a camp_user.
DO $$
BEGIN
    -- link_camper_faces
    DROP POLICY IF EXISTS lcf_staff_all ON public.link_camper_faces;
    CREATE POLICY lcf_staff_all ON public.link_camper_faces FOR ALL
        USING (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_camper_faces.camp_id AND u.user_id = auth.uid())
        )
        WITH CHECK (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_camper_faces.camp_id AND u.user_id = auth.uid())
        );

    -- link_photos
    DROP POLICY IF EXISTS lp_staff_all ON public.link_photos;
    CREATE POLICY lp_staff_all ON public.link_photos FOR ALL
        USING (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_photos.camp_id AND u.user_id = auth.uid())
        )
        WITH CHECK (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_photos.camp_id AND u.user_id = auth.uid())
        );

    -- link_photo_tags
    DROP POLICY IF EXISTS lpt_staff_all ON public.link_photo_tags;
    CREATE POLICY lpt_staff_all ON public.link_photo_tags FOR ALL
        USING (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_photo_tags.camp_id AND u.user_id = auth.uid())
        )
        WITH CHECK (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_photo_tags.camp_id AND u.user_id = auth.uid())
        );
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARENT RPCs (SECURITY DEFINER) — validate camper is on the caller's invite
-- ════════════════════════════════════════════════════════════════════════════

-- helper: does the caller have an active invite for this camp + camper?
CREATE OR REPLACE FUNCTION public._parent_owns_camper(p_camp_id uuid, p_camper_name text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM link_parent_invites i
        WHERE i.user_id = auth.uid()
          AND i.camp_id = p_camp_id
          AND i.status = 'active'
          AND (i.expires_at IS NULL OR i.expires_at > now())
          AND (i.camper_names IS NULL OR i.camper_names ? p_camper_name)
    );
$$;
REVOKE ALL ON FUNCTION public._parent_owns_camper(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public._parent_owns_camper(uuid, text) TO authenticated;

-- ─── 5. set_camper_face_consent — parent opts a child in/out ──────────────────
-- Opting OUT wipes the descriptor + headshot + any existing tags for that child,
-- so recognition and already-distributed visibility both stop immediately.
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
    END IF;

    RETURN jsonb_build_object('success', true, 'consent', p_consent);
END;
$$;
REVOKE ALL ON FUNCTION public.set_camper_face_consent(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_camper_face_consent(uuid, text, boolean) TO authenticated;

-- ─── 6. submit_camper_headshot — parent uploads reference face + descriptor ───
-- Requires consent (implicitly granted here: uploading a headshot IS opting in).
-- The parent's browser computes the descriptor with face-api.js and passes it.
CREATE OR REPLACE FUNCTION public.submit_camper_headshot(
    p_camp_id       uuid,
    p_camper_name   text,
    p_headshot_data text,
    p_descriptor    jsonb
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
    IF p_descriptor IS NULL OR jsonb_array_length(p_descriptor) <> 128 THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_descriptor');
    END IF;
    IF p_headshot_data IS NULL OR length(p_headshot_data) > 1500000 THEN   -- ~1.1MB base64 ceiling
        RETURN jsonb_build_object('success', false, 'error', 'bad_headshot');
    END IF;

    INSERT INTO link_camper_faces (camp_id, camper_name, descriptor, headshot_data, consent, consent_by, consent_at, updated_at)
    VALUES (p_camp_id, p_camper_name, p_descriptor, p_headshot_data, true, caller, now(), now())
    ON CONFLICT (camp_id, camper_name) DO UPDATE
        SET descriptor    = EXCLUDED.descriptor,
            headshot_data  = EXCLUDED.headshot_data,
            consent        = true,
            consent_by     = caller,
            consent_at     = COALESCE(link_camper_faces.consent_at, now()),
            updated_at     = now();

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_camper_headshot(uuid, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_camper_headshot(uuid, text, text, jsonb) TO authenticated;

-- ─── 7. get_my_camper_status — parent sees each child's consent/headshot state ─
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
        'has_face',    (f.descriptor IS NOT NULL),
        'headshot',    f.headshot_data
    )), '[]'::jsonb)
    INTO result
    FROM link_camper_faces f
    WHERE f.camp_id = p_camp_id
      AND public._parent_owns_camper(p_camp_id, f.camper_name);

    RETURN jsonb_build_object('success', true, 'campers', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camper_face_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camper_face_status(uuid) TO authenticated;

-- ─── 8. get_my_camper_photos — parent gallery (only their children's tags) ────
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
          AND public._parent_owns_camper(p_camp_id, t.camper_name)
        ORDER BY p.id, p.created_at DESC
    ) sub;

    RETURN jsonb_build_object('success', true, 'photos', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camper_photos(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camper_photos(uuid, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- STAFF RPCs — the admin console mostly uses direct table access (RLS above),
-- but get_camp_face_index is DEFINER so it can enforce the consent filter and
-- keep descriptor payloads uniform.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 9. get_camp_face_index — consented reference faces for the matcher ────────
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
        'camper_name', f.camper_name,
        'descriptor',  f.descriptor
    )), '[]'::jsonb)
    INTO result
    FROM link_camper_faces f
    WHERE f.camp_id = p_camp_id AND f.consent = true AND f.descriptor IS NOT NULL;

    RETURN jsonb_build_object('success', true, 'faces', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_face_index(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_face_index(uuid) TO authenticated;

-- ─── 10. save_scanned_photo — staff persist an uploaded+scanned photo + tags ──
-- p_tags is a jsonb array of {camper_name, confidence, manual}. Only consented
-- campers can be tagged (enforced here as a second line of defence).
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
            INSERT INTO link_photo_tags (photo_id, camp_id, camper_name, confidence, manual)
            VALUES (new_id, p_camp_id, rec->>'camper_name',
                    NULLIF(rec->>'confidence','')::real,
                    coalesce((rec->>'manual')::boolean, false))
            ON CONFLICT (photo_id, camper_name) DO NOTHING;
            n_tags := n_tags + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'photo_id', new_id, 'tags_saved', n_tags);
END;
$$;
REVOKE ALL ON FUNCTION public.save_scanned_photo(uuid, text, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.save_scanned_photo(uuid, text, text, text, jsonb) TO authenticated;

-- ============================================================================
-- Done. Parent flow: set_camper_face_consent / submit_camper_headshot /
-- get_my_camper_face_status / get_my_camper_photos.
-- Staff flow: get_camp_face_index (build matcher) + save_scanned_photo (persist).
-- ============================================================================
