-- ============================================================================
-- Migration: get_link_camp_forms RPC
--
-- Lets the parent portal (authenticated or anon via invite flow) read the
-- forms and documents configured by the camp admin.  Data is stored in
-- camp_state_kv under key 'link_forms' as a JSON blob.
--
-- Returns:
--   { success: true,  forms: { digital: [...], printReturn: [...], documents: [...] } }
--   { success: false, error: 'not_found' }   -- camp exists but no forms configured yet
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_link_camp_forms(p_camp_id uuid)
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
      AND key     = 'link_forms'
    LIMIT 1;

    IF NOT FOUND OR v_value IS NULL THEN
        -- No forms configured yet — return empty structure so portal renders empty state
        RETURN jsonb_build_object(
            'success', true,
            'forms',   '{"digital":[],"printReturn":[],"documents":[]}'::jsonb
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'forms',   v_value::jsonb
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Allow both authenticated parents and anonymous callers (for invite-link flow)
REVOKE ALL ON FUNCTION public.get_link_camp_forms(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_camp_forms(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_link_camp_forms(uuid) TO anon;

-- ─── Sanity check ─────────────────────────────────────────────────────────────
-- SELECT proname FROM pg_proc WHERE proname = 'get_link_camp_forms';
