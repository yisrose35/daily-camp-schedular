-- ============================================================================
-- Migration 071: get_camp_link_adoption — which parents have claimed Link.
--
-- Why: office broadcasts (campistry_link_admin.html's composer) can already
-- target a division/grade/bunk and resolve it to a list of parents, but has
-- no way to tell which of those parents actually have a claimed Link
-- account versus which never signed up. Without that, a broadcast either
-- reaches only in-app users (silently leaving non-adopters with nothing) or
-- has to blast everyone by SMS/email regardless of whether they'd already
-- see it in-app fine. This RPC gives the composer exactly the signal it
-- needs to split a resolved target list into "will see this in Link" vs
-- "needs the SMS/email fallback".
--
-- Adoption signal: link_parent_invites.user_id IS NOT NULL — set only once
-- claim_parent_invite() runs after the parent's first real sign-in
-- (migration 009). An unclaimed invite (user_id IS NULL) means the parent
-- was invited but has never actually logged into Link.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_camp_link_adoption(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'parent_email', i.parent_email,
        'claimed',      (i.user_id IS NOT NULL)
    )), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    WHERE i.camp_id = p_camp_id
      AND i.status = 'active';

    RETURN jsonb_build_object('success', true, 'parents', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_link_adoption(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_link_adoption(uuid) TO authenticated;

-- Sanity check after running:
--   SELECT proname FROM pg_proc WHERE proname = 'get_camp_link_adoption';
--   -- from an owner/staff session: select get_camp_link_adoption('<camp_id>')
--   -- and confirm it returns one row per active invite with the right
--   -- claimed:true/false split.
