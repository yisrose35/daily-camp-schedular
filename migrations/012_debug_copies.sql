-- ============================================================================
-- Migration: debug-copy registry + super-admin policies (Debug Copy v2)
--
-- WHY THE REDESIGN
--   A camp's "active camp" is resolved independently by several modules
--   (supabase_client, access_control, dashboard, landing). They all check
--   camp_users TEAM MEMBERSHIP first, then fall back to ownership. So the
--   reliable way to make a debug copy load EVERYWHERE is to enter it as a
--   team member of the copy — not as its owner. (Owner-based switching only
--   half-worked and tripped over the camps_owner unique constraint.)
--
--   So a debug copy is a real camps row whose owner is the copy's own id
--   (so it never collides with the super-admin's real camp in owner lookups),
--   and the super-admin joins it via a camp_users row with role 'owner'.
--
-- WHAT THIS ADDS
--   1. debug_copies — registry marking which camps are debug copies and who
--      owns the debugging session. This is the entitlement boundary: a
--      super-admin may only manage membership/lifecycle of camps listed here.
--   2. camps      — super-admin INSERT (create a copy) + DELETE (only debug
--      copies) policies.
--   3. camp_users — super-admin INSERT/DELETE policies, scoped to debug copies
--      and to their OWN membership row. This is what lets them "switch into" a
--      copy. It CANNOT touch real camps' memberships, so originals stay
--      read-only.
--
-- Originals are never written: there is still no super-admin write policy on
-- camp_state_kv / daily_schedules / rotation_counts; writes there only succeed
-- for the camp get_user_camp_id() resolves to, which a super-admin can only
-- point at a debug copy (via a copy membership they're allowed to create).
--
-- Requires migration 010 (is_super_admin()). Idempotent.
-- ============================================================================

-- ─── 1. Registry ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.debug_copies (
    copy_camp_id   uuid        PRIMARY KEY,
    super_admin_id uuid        NOT NULL,
    source_camp_id uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debug_copies_admin
    ON public.debug_copies (super_admin_id);

ALTER TABLE public.debug_copies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS debug_copies_rw ON public.debug_copies;
CREATE POLICY debug_copies_rw ON public.debug_copies
    FOR ALL
    USING (public.is_super_admin() AND super_admin_id = auth.uid())
    WITH CHECK (public.is_super_admin() AND super_admin_id = auth.uid());

-- ─── 2. camps: super-admin create + delete-own-copy ────────────────────────
-- INSERT: a super-admin may create camps (the sandbox copies). Permissive, so
-- it OR's with the normal owner-creates-own-camp policy.
DROP POLICY IF EXISTS camps_super_admin_insert ON public.camps;
CREATE POLICY camps_super_admin_insert ON public.camps
    FOR INSERT
    WITH CHECK (public.is_super_admin());

-- DELETE: a super-admin may delete ONLY camps registered as their debug copy.
DROP POLICY IF EXISTS camps_super_admin_delete ON public.camps;
CREATE POLICY camps_super_admin_delete ON public.camps
    FOR DELETE
    USING (
        public.is_super_admin()
        AND EXISTS (
            SELECT 1 FROM public.debug_copies dc
            WHERE dc.copy_camp_id = camps.id AND dc.super_admin_id = auth.uid()
        )
    );

-- ─── 3. camp_users: super-admin join/leave a debug copy ────────────────────
-- INSERT their OWN owner-membership, but only for a debug copy of theirs.
DROP POLICY IF EXISTS camp_users_super_admin_insert ON public.camp_users;
CREATE POLICY camp_users_super_admin_insert ON public.camp_users
    FOR INSERT
    WITH CHECK (
        public.is_super_admin()
        AND user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.debug_copies dc
            WHERE dc.copy_camp_id = camp_users.camp_id AND dc.super_admin_id = auth.uid()
        )
    );

-- DELETE their own membership rows for debug copies (to switch / leave).
DROP POLICY IF EXISTS camp_users_super_admin_delete ON public.camp_users;
CREATE POLICY camp_users_super_admin_delete ON public.camp_users
    FOR DELETE
    USING (
        public.is_super_admin()
        AND user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.debug_copies dc
            WHERE dc.copy_camp_id = camp_users.camp_id AND dc.super_admin_id = auth.uid()
        )
    );

-- ─── Sanity check ──────────────────────────────────────────────────────────
--   SELECT * FROM public.debug_copies;
--   SELECT polname, cmd FROM pg_policies
--    WHERE tablename IN ('camps','camp_users') AND polname LIKE '%super_admin%';
