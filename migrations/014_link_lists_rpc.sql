-- ============================================================================
-- Migration: get_link_camp_lists RPC — camp lists for the parent portal
--
-- Camp lists (packing lists, what-to-bring, trip-day checklists) are managed
-- by the admin in the Link admin portal and stored in camp_state_kv under key
-- 'link_lists' as a JSON blob (same pattern as 'link_forms' / migration 012).
-- This RPC lets the parent portal read them with an authenticated (or anon,
-- for the invite-link flow) session.
--
-- Returns:
--   { success: true,  lists: [...] }
--   { success: false, error: '...' }
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_link_camp_lists(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value text;
BEGIN
    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id
      AND key     = 'link_lists'
    LIMIT 1;

    IF NOT FOUND OR v_value IS NULL THEN
        RETURN jsonb_build_object('success', true, 'lists', '[]'::jsonb);
    END IF;

    RETURN jsonb_build_object('success', true, 'lists', v_value::jsonb);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_link_camp_lists(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_camp_lists(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_link_camp_lists(uuid) TO anon;

-- ─── Sanity check ─────────────────────────────────────────────────────────────
-- SELECT proname FROM pg_proc WHERE proname = 'get_link_camp_lists';
-- ============================================================================
