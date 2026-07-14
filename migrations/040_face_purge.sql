-- ============================================================================
-- Migration 040: Facial Recognition — end-of-season biometric purge
--
-- The consent story promises retention limits, and biometric-privacy laws
-- (BIPA et al.) expect biometric identifiers DESTROYED when their purpose
-- ends. This RPC is the destroy button: owner-only, per camp.
--
-- What it deletes:
--   * ALL face descriptors (link_camper_face_descriptors — every model/pose)
--   * ALL reference headshots + legacy descriptors (link_camper_faces payload
--     columns nulled; the row is kept with consent=false as an audit record
--     of who had consented — the row contains no biometric data after this)
--   * optionally (p_delete_photos) the photo gallery + tags too
--
-- Tags without photos are NOT biometric data (they're just names on photos),
-- so with p_delete_photos=false the galleries keep working for parents while
-- every face template is gone.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.purge_face_data(
    p_camp_id       uuid,
    p_delete_photos boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    n_descriptors int;
    n_faces int;
    n_photos int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    -- OWNER ONLY — this is destructive; staff membership is not enough
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'owner_only');
    END IF;

    DELETE FROM link_camper_face_descriptors WHERE camp_id = p_camp_id;
    GET DIAGNOSTICS n_descriptors = ROW_COUNT;

    UPDATE link_camper_faces
       SET descriptor = NULL, headshot_data = NULL, consent = false, updated_at = now()
     WHERE camp_id = p_camp_id;
    GET DIAGNOSTICS n_faces = ROW_COUNT;

    IF p_delete_photos THEN
        DELETE FROM link_photos WHERE camp_id = p_camp_id;   -- tags cascade
        GET DIAGNOSTICS n_photos = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'descriptors_deleted', n_descriptors,
        'campers_wiped', n_faces,
        'photos_deleted', n_photos
    );
END;
$$;
REVOKE ALL ON FUNCTION public.purge_face_data(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.purge_face_data(uuid, boolean) TO authenticated;

-- ============================================================================
-- Done. Admin "Season Close-Out" card calls this (type-to-confirm), then
-- clears the local cache. Next season starts from fresh parent enrollments.
-- ============================================================================
