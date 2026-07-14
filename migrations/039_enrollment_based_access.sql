-- ============================================================================
-- Migration 039: Access is enrollment-based, not session-date-gated.
--
-- Reverts the session-window gating (migration 035): a parent has access to Link
-- for as long as their camper is enrolled — no "-21 days / +7 days" window, no
-- session-date cutoff. This matches Campanion (access = principal of an enrolled
-- camper). Access still ENDS when the camper is removed/un-enrolled — that's the
-- offboarding revoke in migration 034 (last child gone → invite revoked), which
-- means the invite is no longer active and the parent simply has no campers.
--
-- Implemented by making link_filter_active_campers a PASS-THROUGH: it returns
-- every camper on the invite (no date filtering), so get_parent_data_by_user /
-- claim_parent_invite grant access whenever the parent has ≥1 enrolled camper.
-- Any accessStart/accessEnd already stamped into camper_data is simply ignored.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.link_filter_active_campers(p_names jsonb, p_data jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'names', coalesce(p_names, '[]'::jsonb),
        'data',  coalesce(p_data,  '{}'::jsonb),
        'count', coalesce(jsonb_array_length(p_names), 0)
    );
$$;
REVOKE ALL ON FUNCTION public.link_filter_active_campers(jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.link_filter_active_campers(jsonb, jsonb) TO authenticated;
