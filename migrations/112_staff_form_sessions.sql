-- ============================================================================
-- Migration 112: expose sessions through get_public_form_config for staff
--
-- The Staff Application Form's "Role & Availability" section only ever
-- collected a free Available From/Until date range — the owner wants
-- applicants to instead pick which camp session(s) they're applying to
-- work, the same sessions[] data already used for camper registration
-- (Dashboard → Dates & Pricing). get_public_form_config('staff') never
-- returned that array (only the 'registration' branch did, since only the
-- camper form needed it until now), so campistry_staff_apply.html has no
-- way to render a real session picker for a logged-out applicant.
--
-- CREATE OR REPLACE on the same function from migrations 084/090 —
-- identical except for the one added key in the 'staff' branch. Idempotent,
-- safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_form_config(
    p_camp_id uuid,
    p_kind    text   -- 'registration' | 'staff'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row  record;
    kv_value  jsonb;
BEGIN
    IF p_kind NOT IN ('registration', 'staff') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_kind');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF p_kind = 'registration' THEN
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'formConfig', coalesce(kv_value -> 'formConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb),
            'sessionBundles', coalesce(kv_value -> 'sessionBundles', '[]'::jsonb),
            'promoCodes', coalesce(kv_value -> 'promoCodes', '{}'::jsonb),
            'schoolGrades', coalesce(kv_value #> '{bunkGenConfig,schoolGrades}', '[]'::jsonb)
        );
    ELSE
        RETURN jsonb_build_object(
            'success', true,
            'campName', camp_row.name,
            'staffFormConfig', coalesce(kv_value -> 'staffFormConfig', '{}'::jsonb),
            'sessions', coalesce(kv_value -> 'sessions', '[]'::jsonb)
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_form_config(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_form_config(uuid, text) TO anon, authenticated;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   select get_public_form_config('<a real camp id>'::uuid, 'staff');
--   -- confirm the result includes a "sessions" key (an array, [] if the
--   -- camp has none configured yet).
