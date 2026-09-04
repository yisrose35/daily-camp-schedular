-- =============================================================================
-- Migration 114: fix get_public_form_config to include session bundles.
--
-- BUG FOUND: campistry_register.html's registration bootstrap
-- (_loadFromCloud) already reads `bundles=d.sessionBundles||[]` from
-- get_public_form_config's response (migration 084) — but that function's
-- 'registration' branch never selects sessionBundles from the stored
-- campistryMe blob at all, only `sessions`. So for any real, first-time
-- anonymous visitor (the only path that matters — the local-cache path only
-- ever has data on a device that already hydrated real cloud data, e.g. an
-- office computer), `bundles` is always `[]` and a "Full Summer" bundle
-- never appears on the actual public registration form, no matter how it's
-- configured in Dashboard → Sessions & Pricing.
--
-- Fix: CREATE OR REPLACE the same function (migration 084), adding
-- sessionBundles to the 'registration' branch's response — same
-- coalesce-to-empty-array shape already used for `sessions`.
-- =============================================================================

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

-- Note: 'staff' branch also picked up `sessions` here (it was missing
-- before too) — campistry_staff_apply.html's session-picker checkboxes
-- (added earlier this session) read `me.sessions`/`d.sessions` the same
-- way the registration form does, and had the identical gap for a real
-- anonymous staff applicant.

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'get_public_form_config';
--   select get_public_form_config('<a real camp id>'::uuid, 'registration');
--   -- confirm the result includes a non-empty "sessionBundles" array for a
--   -- camp that has real bundles configured in Dashboard.
-- =============================================================================
