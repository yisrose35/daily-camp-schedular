-- ============================================================================
-- Migration 104: let the POS shadow account read the camper roster
--
-- Bug: the POS's shadow login (role='counselor', see migration 100) can
-- see snacks inventory but not campers. Root cause: camp_state_kv's
-- current SELECT policy (migration 098) deliberately blocks 'counselor'
-- from reading key='app1' (along with campistryMe/campistryHealth) —
-- a real, INTENTIONAL privacy carve-out for actual bunk counselors using
-- Campistry Lite, who shouldn't see the whole camp's roster/finance/health
-- data through the generic cloud_bootstrap fetch. The POS shadow account
-- happens to share that same role, so it inherited the same block —
-- but it genuinely needs the camper list (name/division/bunk) to run the
-- register.
--
-- Fix: NOT widening the counselor app1 exclusion (that would defeat the
-- privacy carve-out for real Lite counselors too). Instead, a narrowly-
-- scoped RPC that returns ONLY app1's camperRoster sub-object — no
-- structure, no settings, no health/finance data, just
-- {camperName: {division, bunk, team}} — the same minimal shape the POS
-- already reads locally. Any authenticated member of the camp can call it
-- (verified inside the function body, same pattern as every other RPC in
-- this app); the SELECT-policy carve-out this migration works around stays
-- completely untouched for every other read path.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_pos_roster(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    v_is_member boolean;
    v_roster    jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    v_is_member :=
        EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = caller)
        OR EXISTS (SELECT 1 FROM camp_users
                   WHERE camp_id = p_camp_id AND user_id = caller AND accepted_at IS NOT NULL);

    IF NOT v_is_member THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT value -> 'camperRoster' INTO v_roster
    FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'app1';

    RETURN jsonb_build_object('success', true, 'camperRoster', COALESCE(v_roster, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_roster(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_pos_roster(uuid) TO authenticated;


-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'get_pos_roster';
--   -- expect grant to authenticated
-- ============================================================================
