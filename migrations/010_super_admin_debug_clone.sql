-- ============================================================================
-- Migration: platform super-admin read-only access + deterministic active-camp
--            selection (powers the "Debug Copy" / camp clone feature)
--
-- GOAL
--   The platform owner needs to (a) READ any camp's full state in order to
--   clone it into a sandbox camp on their own account for debugging, and
--   (b) once the sandbox copy exists (owned by them), WRITE to that specific
--   copy deterministically — even though they now own multiple camps.
--
--   The original camp is ONLY ever read. There is intentionally NO super-admin
--   INSERT/UPDATE/DELETE policy, so even a buggy client literally cannot write
--   to a camp it does not own. That is the hard guarantee behind "read-only on
--   the original."
--
-- WHAT THIS DOES
--   1. super_admins table — the allow-list of platform owners. Managed ONLY
--      from the SQL editor (service role); no client write policy.
--   2. is_super_admin() — SECURITY DEFINER helper, used by additive SELECT
--      policies so a super-admin can read ANY row in the camp tables.
--   3. active_camp_selection — a per-user "which camp am I currently working
--      in" pointer, honored ONLY for camps the user is entitled to (owns or is
--      an accepted member of). Lets an owner of several camps deterministically
--      switch the camp their writes are scoped to.
--   4. get_user_camp_id() / get_user_role() — redefined as a STRICT SUPERSET of
--      migration 005: the active selection (entitlement-checked) takes
--      priority, then the existing camp_users-most-recent rule, then the owner
--      fallback. Backward compatible: with no selection row, behavior is
--      identical to today for both members and owners.
--
-- Idempotent. DROP POLICY IF EXISTS / CREATE OR REPLACE throughout.
-- ============================================================================

-- ─── 1. super_admins allow-list ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.super_admins (
    user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

-- A user may read ONLY their own super-admin row (so the client can ask
-- "am I a super admin?"). No INSERT/UPDATE/DELETE policy: membership is
-- granted exclusively via the SQL editor below.
DROP POLICY IF EXISTS super_admins_self_read ON public.super_admins;
CREATE POLICY super_admins_self_read ON public.super_admins
    FOR SELECT
    USING (user_id = auth.uid());

-- ─── 2. is_super_admin() helper ────────────────────────────────────────────
-- SECURITY DEFINER so it can read super_admins regardless of the caller's RLS.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.super_admins sa WHERE sa.user_id = auth.uid()
    )
$$;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- ─── 3. active_camp_selection pointer ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.active_camp_selection (
    user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    camp_id    uuid        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.active_camp_selection ENABLE ROW LEVEL SECURITY;

-- A user fully controls ONLY their own selection row. The entitlement check
-- (does the user actually have rights to that camp?) happens in
-- get_user_camp_id(), so a stale/forged camp_id here can never widen access.
DROP POLICY IF EXISTS active_camp_selection_rw ON public.active_camp_selection;
CREATE POLICY active_camp_selection_rw ON public.active_camp_selection
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ─── 4. Redefine get_user_camp_id() / get_user_role() (superset of 005) ─────
-- get_user_camp_id(): explicit selection (entitlement-checked) → camp_users
-- most-recent → owner fallback. The owner fallback prefers the camp whose id
-- equals the user's uid (the signup convention) so single-camp owners are
-- unaffected.
CREATE OR REPLACE FUNCTION public.get_user_camp_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        -- (1) Explicit active-camp selection, honored ONLY if the user is
        --     genuinely entitled to it (owns it OR is an accepted member).
        (SELECT acs.camp_id
           FROM active_camp_selection acs
          WHERE acs.user_id = auth.uid()
            AND (
                EXISTS (SELECT 1 FROM camps c
                         WHERE c.id = acs.camp_id AND c.owner = auth.uid())
                OR EXISTS (SELECT 1 FROM camp_users cu
                            WHERE cu.user_id = auth.uid()
                              AND cu.camp_id = acs.camp_id
                              AND cu.accepted_at IS NOT NULL)
            )
          LIMIT 1),
        -- (2) Existing rule: most recently accepted membership.
        (SELECT cu.camp_id
           FROM camp_users cu
          WHERE cu.user_id = auth.uid()
            AND cu.accepted_at IS NOT NULL
          ORDER BY cu.accepted_at DESC
          LIMIT 1),
        -- (3) Owner fallback: a camp this user owns. Prefer id = uid.
        (SELECT c.id
           FROM camps c
          WHERE c.owner = auth.uid()
          ORDER BY (c.id = auth.uid()) DESC
          LIMIT 1)
    )
$$;

REVOKE ALL ON FUNCTION public.get_user_camp_id() FROM public;
GRANT EXECUTE ON FUNCTION public.get_user_camp_id() TO authenticated;

-- get_user_role(): role within the resolved active camp. Adds an explicit
-- owner branch (owns the active camp → 'owner') so owners writing to a camp
-- they own — including a debug copy — are correctly authorized.
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
        (SELECT 'owner'::text
           FROM camps c
          WHERE c.id = public.get_user_camp_id()
            AND c.owner = auth.uid()
          LIMIT 1),
        'viewer'
    )
$$;

REVOKE ALL ON FUNCTION public.get_user_role() FROM public;
GRANT EXECUTE ON FUNCTION public.get_user_role() TO authenticated;

-- ─── 5. Additive READ-ONLY super-admin policies on the camp tables ─────────
-- These are PERMISSIVE policies, so they OR with the existing per-camp
-- policies: normal users are unaffected (is_super_admin() is false for them),
-- and a super-admin gains SELECT on every row. No write policies are added.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'camps', 'camp_users', 'camp_state_kv', 'daily_schedules',
        'rotation_counts', 'camp_state', 'subdivisions'
    ]
    LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = t
        ) THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
            EXECUTE format('DROP POLICY IF EXISTS super_admin_read_all ON public.%I', t);
            EXECUTE format(
                'CREATE POLICY super_admin_read_all ON public.%I FOR SELECT USING (public.is_super_admin())',
                t
            );
        END IF;
    END LOOP;
END $$;

-- ─── 6. Grant the platform owner super-admin (EDIT the email if needed) ─────
-- Runs in the SQL editor as the postgres role, so it can read auth.users.
INSERT INTO public.super_admins (user_id, note)
SELECT id, 'platform owner'
  FROM auth.users
 WHERE lower(email) = lower('yisrose24@gmail.com')
ON CONFLICT (user_id) DO NOTHING;

-- ─── 7. Sanity checks (run manually) ───────────────────────────────────────
--   SELECT * FROM public.super_admins;
--   SELECT polname, cmd FROM pg_policies WHERE polname = 'super_admin_read_all';
--   -- As the owner, after selecting a copy:
--   --   SELECT public.get_user_camp_id();  -- should equal the copy's id
--   --   SELECT public.get_user_role();     -- should be 'owner'
