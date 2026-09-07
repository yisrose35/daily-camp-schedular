-- =============================================================================
-- Migration 113: anon-safe application status lookup.
--
-- BUG FOUND: the "Check your application status" link
-- (campistry_register.html, showStatus()) has three fallbacks — a local
-- localStorage snapshot, the IndexedDB-backed local cache, and finally a
-- "direct Supabase query" meant to make the link work from any device. That
-- third fallback does:
--     client.from('camp_state_kv').select('value').eq('camp_id', campId)...
-- as an ANONYMOUS caller — but camp_state_kv's own RLS SELECT policy
-- (migration 001) requires camp_id = get_user_camp_id(), which only
-- resolves for an authenticated staff session. An anonymous parent's
-- caller-camp is always NULL, so this query returns zero rows every time,
-- no matter how correct the campId is. It's dead code.
--
-- Net effect: the status link only ever "works" when the browser that's
-- opening it still has the application cached locally from the moment it
-- was submitted — and even that's unreliable, since the localStorage
-- snapshot deliberately strips `enrollments` to stay under quota. Check
-- from a different device, a different day, or after any cache eviction,
-- and it reliably shows "Application Not Found" even though the
-- application is really sitting in the database.
--
-- Fix: same pattern as get_postaccept_bootstrap (migration 084) — the
-- application id already doubles as an unguessable bearer credential (it's
-- only ever handed to the one family it belongs to), so a narrow
-- SECURITY DEFINER RPC can safely return just the small, already-public-
-- facing slice of that ONE application's status. Never the full
-- enrollments blob, never any other family's data.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_public_application_status(
    p_camp_id uuid,
    p_app_id  text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    kv_value  jsonb;
    app_row   jsonb;
BEGIN
    IF p_camp_id IS NULL OR p_app_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT value INTO kv_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';

    app_row := kv_value -> 'enrollments' -> p_app_id;
    IF app_row IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'application_not_found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'camperName', coalesce(app_row ->> 'camperName', ''),
        'status', coalesce(app_row ->> 'status', 'pending'),
        'session', coalesce(app_row ->> 'session', ''),
        'appliedDate', coalesce(app_row ->> 'appliedDate', ''),
        'paymentStatus', coalesce(app_row ->> 'paymentStatus', 'pending'),
        'formsCompleted', coalesce((app_row ->> 'formsCompleted')::int, 0),
        'formsRequired', coalesce((app_row ->> 'formsRequired')::int, 0)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_public_application_status(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_public_application_status(uuid, text) TO anon, authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proacl from pg_proc where proname = 'get_public_application_status';
--   -- should show anon among the grantees.
--   select get_public_application_status('<a real camp id>'::uuid, '<a real application id>');
-- =============================================================================
