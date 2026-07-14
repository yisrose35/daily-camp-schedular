-- ============================================================================
-- Migration 036: Parents cannot own the rest of Campistry.
--
-- The client guard (parent_lockout_guard.js) bounces parent accounts out of the
-- product UI. This is the SERVER backstop: a parent account can never create or
-- own a camp, so RLS (which already gates all product data on camp ownership /
-- camp_users membership) denies them everything. "Staff wins": an account that
-- already owns a camp or is a camp_users member is unaffected.
-- ============================================================================

-- ─── who is a parent? (has claimed a Link parent invite) ─────────────────────
CREATE OR REPLACE FUNCTION public.is_link_parent(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (SELECT 1 FROM link_parent_invites WHERE user_id = p_uid);
$$;
REVOKE ALL ON FUNCTION public.is_link_parent(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_link_parent(uuid) TO authenticated;

-- ─── block camp creation by pure-parent accounts ────────────────────────────
CREATE OR REPLACE FUNCTION public.block_parent_camp_creation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.owner IS NOT NULL
       AND public.is_link_parent(NEW.owner)
       -- staff-wins escape hatches: already owns a camp, or is a camp_users member
       AND NOT EXISTS (SELECT 1 FROM camps c      WHERE c.owner   = NEW.owner AND c.id <> NEW.id)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.user_id = NEW.owner)
    THEN
        RAISE EXCEPTION 'parent_accounts_cannot_create_camps'
            USING HINT = 'This account is a Campistry Link parent account.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_parent_camp_creation ON public.camps;
CREATE TRIGGER trg_block_parent_camp_creation
    BEFORE INSERT ON public.camps
    FOR EACH ROW EXECUTE FUNCTION public.block_parent_camp_creation();

-- ─── clean up blank camps parent accounts already auto-created ───────────────
-- Only camps that are (1) owned by a parent, (2) have NO camp_state_kv data,
-- (3) whose owner isn't staff anywhere, and (4) are that owner's only camp.
-- Empty by definition, so nothing of value is lost.
DELETE FROM public.camps c
WHERE public.is_link_parent(c.owner)
  AND NOT EXISTS (SELECT 1 FROM camp_state_kv k WHERE k.camp_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM camp_users  u WHERE u.user_id = c.owner)
  AND (SELECT count(*) FROM camps c2 WHERE c2.owner = c.owner) = 1;
