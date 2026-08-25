-- =============================================================================
-- Migration 086: Post-Hire Form — anon-safe read + submit RPCs.
--
-- New feature, same shape as the camper Post-Acceptance Form (migrations
-- 083/084): a second form, distinct from the Staff Application itself,
-- sent AFTER a candidate reaches the Hired stage — collects onboarding
-- logistics (t-shirt size, arrival date, emergency contact, handbook
-- acknowledgment, etc., all camp-configurable) back onto the SAME
-- application record (staffApplications[id].postHire). Built anon-safe
-- from day one — no direct client SELECT/UPSERT against camp_state_kv
-- anywhere in this feature, unlike the forms that had to be retrofitted.
-- =============================================================================

-- ─── 1. get_posthire_bootstrap — read one hire's post-hire form ────────────
-- Narrow on purpose: the application id doubles as a bearer credential
-- (unguessable, emailed only to that one candidate) — this returns only
-- the tiny slice of that ONE application needed to render the form
-- (candidate's name, whether it's already been submitted), never the full
-- application record (references, resume, phone/address, other
-- candidates' data) and never any other applicant's data.
CREATE OR REPLACE FUNCTION public.get_posthire_bootstrap(
    p_camp_id uuid,
    p_app_id  text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row record;
    kv_value jsonb;
    app_row  jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_app_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    app_row := kv_value -> 'staffApplications' -> p_app_id;
    IF app_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;
    IF (app_row ->> 'status') IS DISTINCT FROM 'hired' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_hired');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'campName', camp_row.name,
        'candidateName', coalesce(
            nullif(app_row ->> 'name', ''),
            trim(coalesce(app_row ->> 'first', '') || ' ' || coalesce(app_row ->> 'last', ''))
        ),
        'alreadySubmitted', (app_row -> 'postHire') IS NOT NULL,
        'submittedDate', app_row #>> '{postHire,submittedDate}',
        'postHireFormConfig', coalesce(kv_value -> 'postHireFormConfig', '{}'::jsonb)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_posthire_bootstrap(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_posthire_bootstrap(uuid, text) TO anon, authenticated;

-- ─── 2. submit_posthire_response — the hire's onboarding answers ───────────
-- Mirrors submit_postaccept_response (migration 083) exactly, one tier
-- over on the hiring side: can only merge a postHire object onto an
-- application that already exists, atomically, server-side — no
-- read-modify-write from this browser, so two people submitting around
-- the same moment (or a concurrent office edit) can never clobber each
-- other's data.
CREATE OR REPLACE FUNCTION public.submit_posthire_response(
    p_camp_id  uuid,
    p_app_id   text,
    p_posthire jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    existing jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_app_id IS NULL OR p_posthire IS NULL OR jsonb_typeof(p_posthire) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;
    IF pg_column_size(p_posthire) > 8388608 THEN
        RETURN jsonb_build_object('success', false, 'error', 'submission_too_large');
    END IF;

    SELECT value -> 'staffApplications' -> p_app_id INTO existing
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe';

    IF existing IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    UPDATE camp_state_kv
    SET value = jsonb_set(
            value,
            ARRAY['staffApplications', p_app_id],
            (existing || jsonb_build_object('postHire', p_posthire)),
            true
        ),
        updated_at = now()
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_posthire_response(uuid, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_posthire_response(uuid, text, jsonb) TO anon, authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'get_posthire_bootstrap';
--   select proacl from pg_proc where proname = 'submit_posthire_response';
--   -- both should show anon among the grantees.
--   select get_posthire_bootstrap('<a real camp id>'::uuid, '<a real application id>');
-- =============================================================================
