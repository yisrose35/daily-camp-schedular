-- ============================================================================
-- Migration: capture get_user_camp_id() / get_user_role() in version control
--
-- Why: Every RLS policy in 001_camp_state_kv.sql, 002_rotation_counts.sql,
--      003_daily_schedules_rls.sql, and 004_schedule_proposals_rls.sql
--      delegates the entire access decision to these two helpers. Their
--      bodies were never in this repo — they live only in the Supabase
--      dashboard. Single shared trust point with invisible source = the
--      audit can't certify multi-tenant isolation.
--
-- This file is the documented expectation. If the live functions diverge
-- from these definitions, the deployment is responsible for reconciling.
--
-- Idempotent. SECURITY DEFINER means the function runs with the function
-- owner's privileges, not the caller's — required so RLS can read
-- camp_users without recursion. STABLE because the result depends only
-- on the JWT for the current statement.
--
-- search_path is pinned to public,pg_catalog to prevent search-path
-- attacks against SECURITY DEFINER functions.
-- ============================================================================

-- ─── get_user_camp_id() ────────────────────────────────────────────────────
-- Returns the camp_id this user is currently scoped to. Multi-camp users
-- are deterministically resolved by accepting the most recently joined
-- accepted membership.
CREATE OR REPLACE FUNCTION public.get_user_camp_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT cu.camp_id
    FROM camp_users cu
    WHERE cu.user_id = auth.uid()
      AND cu.accepted_at IS NOT NULL
    ORDER BY cu.accepted_at DESC
    LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.get_user_camp_id() FROM public;
GRANT EXECUTE ON FUNCTION public.get_user_camp_id() TO authenticated;

-- ─── get_user_role() ───────────────────────────────────────────────────────
-- Returns the user's role in the active camp (matched to get_user_camp_id).
-- 'viewer' if no membership found — fail-closed.
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        (SELECT cu.role
         FROM camp_users cu
         WHERE cu.user_id = auth.uid()
           AND cu.camp_id = public.get_user_camp_id()
           AND cu.accepted_at IS NOT NULL
         LIMIT 1),
        'viewer'
    )
$$;

REVOKE ALL ON FUNCTION public.get_user_role() FROM public;
GRANT EXECUTE ON FUNCTION public.get_user_role() TO authenticated;
