-- ============================================================================
-- Migration: parent Supabase Auth integration
--
-- Adds user_id to link_parent_invites so a parent's Supabase Auth account
-- is permanently linked to their invite after they sign up.
-- Once linked, the parent can sign in from any device with email + password
-- and their data loads from their linked invite row.
--
-- New RPC claim_parent_invite(p_token):
--   Called right after supabase.auth.signUp() succeeds.
--   Links auth.uid() → invite row and returns the parent's data.
--   SECURITY DEFINER — runs as the function owner so it can write
--   link_parent_invites even though the parent's session doesn't yet
--   satisfy the admin-only UPDATE policy.
-- ============================================================================

-- ─── 1. Add user_id column ────────────────────────────────────────────────────
ALTER TABLE link_parent_invites
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_link_parent_invites_user
    ON link_parent_invites (user_id);

-- ─── 2. New RLS: parent can read their own invite after linking ───────────────
DROP POLICY IF EXISTS link_parent_invites_parent_select ON link_parent_invites;
CREATE POLICY link_parent_invites_parent_select ON link_parent_invites
    FOR SELECT
    USING (user_id = auth.uid());

-- ─── 3. RPC: claim_parent_invite ─────────────────────────────────────────────
-- Called by parent portal after supabase.auth.signUp() or signIn() succeeds.
-- Links the authenticated user to their invite token (idempotent).
-- Returns parent + camper data so the portal can render immediately.
CREATE OR REPLACE FUNCTION public.claim_parent_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv    link_parent_invites;
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    -- Find the invite
    SELECT * INTO inv
    FROM link_parent_invites
    WHERE token = p_token
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_or_expired');
    END IF;

    -- Guard: if already claimed by a DIFFERENT user, reject
    IF inv.user_id IS NOT NULL AND inv.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    -- Link (idempotent — safe to call again from same user)
    UPDATE link_parent_invites
    SET user_id = caller
    WHERE id = inv.id;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', inv.camper_names,
        'camper_data',  inv.camper_data
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_parent_invite(text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_parent_invite(text) TO authenticated;

-- ─── 4. RPC: get_parent_data_by_user ─────────────────────────────────────────
-- Called on sign-in from a device that has no stored session.
-- Returns the parent's data using their auth.uid() alone (no token needed).
CREATE OR REPLACE FUNCTION public.get_parent_data_by_user()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv    link_parent_invites;
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_invite_found');
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', inv.camper_names,
        'camper_data',  inv.camper_data
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_parent_data_by_user() FROM public;
GRANT EXECUTE ON FUNCTION public.get_parent_data_by_user() TO authenticated;

-- ─── 5. Sanity check ──────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'link_parent_invites' AND column_name = 'user_id';
--
-- SELECT proname FROM pg_proc
-- WHERE proname IN ('claim_parent_invite','get_parent_data_by_user');
