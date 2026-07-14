-- ============================================================================
-- Migration 031: Facial Recognition — index version fingerprint
--
-- The admin console caches the face-matcher index locally, but had no way to
-- know when the CLOUD enrollment data changed (new camper enrolled, parent
-- added/updated photos, consent revoked, confirmed descriptor promoted from
-- another device). Staff compensated by manually re-running "Build Index"
-- before every send — pure waste when nothing changed.
--
-- This RPC returns a cheap fingerprint of the enrollment state. Clients
-- compare it to the fingerprint stored alongside their cached index: same →
-- cached index is provably fresh, skip the rebuild; different → rebuild
-- silently. Counting BOTH tables catches every mutation path: enroll/update
-- bumps counts or max timestamps, consent revocation deletes rows (count
-- drops), promotions insert rows.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_face_index_version(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'version', (
            SELECT md5(
                coalesce((SELECT count(*)::text || '|' || coalesce(max(f.updated_at)::text, '')
                          FROM link_camper_faces f
                          WHERE f.camp_id = p_camp_id AND f.consent = true AND
                                (f.descriptor IS NOT NULL OR EXISTS (
                                    SELECT 1 FROM link_camper_face_descriptors d
                                    WHERE d.camp_id = f.camp_id AND d.camper_name = f.camper_name))), '0|')
                || '#' ||
                coalesce((SELECT count(*)::text || '|' || coalesce(max(d.created_at)::text, '')
                          FROM link_camper_face_descriptors d
                          WHERE d.camp_id = p_camp_id), '0|')
            )
        )
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_face_index_version(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_face_index_version(uuid) TO authenticated;

-- ============================================================================
-- Done. Client flow: ensureFreshIndex() → compare fingerprint → rebuild only
-- on change. "Build Index" becomes a silent, automatic freshness check.
-- ============================================================================
