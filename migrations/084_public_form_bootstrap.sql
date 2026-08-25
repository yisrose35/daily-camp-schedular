-- =============================================================================
-- Migration 084: anon-safe READ access for the public application forms.
--
-- CRITICAL BUG FOUND: campistry_register.html, campistry_staff_apply.html,
-- and campistry_postaccept.html have never had a way to know which camp
-- they belong to on a genuinely first-time visit. Every link the app
-- generates (copyRegLink, copyStaffLink, QR codes, Send Link emails,
-- _postAcceptUrl) was just origin/campistry_register.html with no camp
-- identifier at all. getCampId() (supabase_client.js) only ever resolves
-- via an AUTHENTICATED session's camp membership/ownership — a public,
-- logged-out visitor has none, and detectCampAndRole() returns immediately
-- if there's no signed-in user. Even when a camp id WAS known, RLS on
-- camp_state_kv (migration 001) requires camp_id = get_user_camp_id(),
-- which blocks anon SELECT entirely — there was no way to read a camp's
-- public form config/sessions/branding without being staff.
--
-- Net effect: a real applicant clicking a real link on their own device —
-- the only case that actually matters — has always seen a blank/generic
-- form (no camp name, no sessions, no custom fields) and had submission
-- fail once they reached Submit. Every prior test that "worked" was from
-- a browser already logged into Me/Dashboard on the same origin, where
-- cached localStorage papered over the whole gap.
--
-- Fix, paired with client-side changes (same commit) that embed
-- ?camp=<id> in every generated link: two narrow, whitelisted
-- SECURITY DEFINER RPCs granted to anon, each returning ONLY the specific
-- public-safe fields a form needs to render — never the full campistryMe
-- blob, which also holds enrollments, staffApplications, families, and
-- other office-only data.
-- =============================================================================

-- ─── 1. get_public_form_config — registration / staff application forms ───
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

-- ─── 2. get_postaccept_bootstrap — one specific enrollment's post-accept form ──
-- Narrower than #1 on purpose: the enrollment id doubles as a bearer
-- credential (unguessable, emailed only to that one family) — this
-- returns only the tiny slice of that ONE enrollment needed to render
-- the form (camper's name, whether it's already been submitted), never
-- the full enrollment record (address, medical info, parent contact,
-- etc.) and never any other family's data.
CREATE OR REPLACE FUNCTION public.get_postaccept_bootstrap(
    p_camp_id   uuid,
    p_enroll_id text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    camp_row   record;
    kv_value   jsonb;
    enroll_row jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_enroll_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT id, name INTO camp_row FROM camps WHERE id = p_camp_id;
    IF camp_row.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    enroll_row := kv_value -> 'enrollments' -> p_enroll_id;
    IF enroll_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'enrollment_not_found');
    END IF;
    IF (enroll_row ->> 'status') NOT IN ('accepted', 'enrolled') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_accepted');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'campName', camp_row.name,
        'camperName', coalesce(enroll_row ->> 'camperName', ''),
        'alreadySubmitted', (enroll_row -> 'postAccept') IS NOT NULL,
        'submittedDate', enroll_row #>> '{postAccept,submittedDate}',
        'postAcceptFormConfig', coalesce(kv_value -> 'postAcceptFormConfig', '{}'::jsonb),
        'bunkGenConfig', jsonb_build_object(
            'requestsEnabled', coalesce(kv_value #> '{bunkGenConfig,requestsEnabled}', 'true'::jsonb),
            'maxRequests', coalesce(kv_value #> '{bunkGenConfig,maxRequests}', '2'::jsonb),
            'honoredRequests', coalesce(kv_value #> '{bunkGenConfig,honoredRequests}', '2'::jsonb),
            'doNotBunkEnabled', coalesce(kv_value #> '{bunkGenConfig,doNotBunkEnabled}', 'true'::jsonb),
            'maxDoNotBunk', coalesce(kv_value #> '{bunkGenConfig,maxDoNotBunk}', '2'::jsonb)
        )
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_postaccept_bootstrap(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_postaccept_bootstrap(uuid, text) TO anon, authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'get_public_form_config';
--   select proacl from pg_proc where proname = 'get_postaccept_bootstrap';
--   -- both should show anon among the grantees.
--   select get_public_form_config('<a real camp id>'::uuid, 'registration');
--   select get_postaccept_bootstrap('<a real camp id>'::uuid, '<a real enrollment id>');
-- =============================================================================
