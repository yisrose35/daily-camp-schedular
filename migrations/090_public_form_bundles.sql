-- ============================================================================
-- Migration 090: expose sessionBundles through get_public_form_config
--
-- Sessions & Pricing (Dashboard → Dates & Pricing) now supports Bundles — a
-- combined price across 2+ sessions (e.g. 1st Half + 2nd Half individually
-- at $2,000 each, but a "Full Summer" bundle of both at $3,500), stored at
-- campistryMe.sessionBundles alongside campistryMe.sessions. The public
-- registration form (campistry_register.html) now renders bundles as just
-- another pickable option alongside sessions — but get_public_form_config
-- (migration 084) never returned that field at all, so a real (logged-out)
-- applicant would never see any bundle a camp configured, even though the
-- office-side UI shows it as if it were live everywhere.
--
-- CREATE OR REPLACE on the same function from migration 084 — identical
-- except for the one added key in the 'registration' branch. Idempotent,
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
            'staffFormConfig', coalesce(kv_value -> 'staffFormConfig', '{}'::jsonb)
        );
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_form_config(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_form_config(uuid, text) TO anon, authenticated;

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   select get_public_form_config('<a real camp id>'::uuid, 'registration');
--   -- confirm the result includes a "sessionBundles" key (an array, [] if
--   -- the camp has none configured yet).
