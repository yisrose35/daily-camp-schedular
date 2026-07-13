-- ============================================================================
-- Migration 030: Facial Recognition — enrollment freshness
--
-- Longitudinal child-face data (YFA, arXiv 2408.07225) shows recognition of
-- children degrades steeply as enrollment photos age across YEARS (98.5% TAR
-- at a 2-year gap → 71% at 8 years), while within one season aging is a
-- non-issue. So: descriptor timestamps flow to the clients, letting the
-- matcher exclude stale multi-season enrollments and the parent portal prompt
-- for fresh photos each summer. No schema changes — created_at already exists
-- on link_camper_face_descriptors; this only extends two RPC payloads.
-- ============================================================================

-- ─── 1. get_camp_face_index — include per-descriptor created_at ──────────────
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
                       'source',     d.source,
                       'created_at', d.created_at
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
                        'pose', 'front', 'source', 'parent', 'created_at', f.updated_at))
                    ELSE '[]'::jsonb
               END AS descriptors
        FROM link_camper_faces f
        WHERE f.camp_id = p_camp_id AND f.consent = true
    ) sub
    WHERE jsonb_array_length(sub.descriptors) > 0;

    RETURN jsonb_build_object('success', true, 'faces', result);
END;
$$;

-- ─── 2. get_my_camper_face_status — poses carry their upload date ─────────────
-- poses becomes [{pose, at}] (was a plain array of pose names).
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
            SELECT coalesce(jsonb_agg(jsonb_build_object('pose', p.pose, 'at', p.latest)), '[]'::jsonb)
            FROM (
                SELECT d.pose, max(d.created_at) AS latest
                FROM link_camper_face_descriptors d
                WHERE d.camp_id = f.camp_id AND d.camper_name = f.camper_name
                  AND d.source = 'parent'
                GROUP BY d.pose
            ) p
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
-- Done. Clients: matcher excludes parent descriptors older than ~10 months
-- (stale multi-season enrollments) and flags those campers for re-enrollment;
-- the parent portal shows "update for this summer" on stale poses.
-- ============================================================================
