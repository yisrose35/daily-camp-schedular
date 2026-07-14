-- ============================================================================
-- Migration 042: Connect newly-added campers/camps to an existing parent.
--
-- claim_invites_by_email() binds every unclaimed invite matching the parent's
-- email — but it only runs at signup. When a camp adds a SECOND child (often at
-- a DIFFERENT camp) AFTER the parent already registered, that new invite has
-- user_id = NULL and get_my_camps() (which filters user_id = caller) never sees
-- it. The parent silently misses the new camper.
--
-- These two RPCs close that gap WITHOUT auto-connecting (the parent is asked):
--   get_connectable_invites() — list invites matching the caller's confirmed
--       email that are NOT yet bound to them, so the portal can prompt
--       "Camp X added <child> — connect?".
--   connect_parent_invite(p_invite_id) — bind ONE such invite to the caller
--       (per-camp consent), after re-checking the email matches. Idempotent.
-- ============================================================================

-- ─── 1. Discover: invites for my email that I haven't connected yet ──────────
CREATE OR REPLACE FUNCTION public.get_connectable_invites()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_email text;
    v_confirmed timestamptz;
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT lower(u.email), u.email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users u WHERE u.id = caller;
    IF v_email IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_email'); END IF;
    -- Only surface after the email is confirmed — same bar as claim_invites_by_email.
    IF v_confirmed IS NULL THEN RETURN jsonb_build_object('success', true, 'invites', '[]'::jsonb); END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'invite_id',    i.id,
        'camp_id',      i.camp_id,
        'camp_name',    coalesce(NULLIF(btrim(c.name), ''), 'Camp'),
        'camper_names', i.camper_names,
        'created_at',   i.created_at
    ) ORDER BY i.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    LEFT JOIN camps c ON c.id = i.camp_id
    WHERE lower(i.parent_email) = v_email
      AND i.status = 'active'
      AND (i.expires_at IS NULL OR i.expires_at > now())
      AND i.user_id IS NULL;   -- not yet connected to this (or any) account

    RETURN jsonb_build_object('success', true, 'invites', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_connectable_invites() FROM public;
GRANT EXECUTE ON FUNCTION public.get_connectable_invites() TO authenticated;

-- ─── 2. Connect one invite (per-camp consent) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.connect_parent_invite(p_invite_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_email text;
    v_confirmed timestamptz;
    inv link_parent_invites;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_invite_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'missing_invite'); END IF;

    SELECT lower(u.email), u.email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users u WHERE u.id = caller;
    IF v_email IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_email'); END IF;
    IF v_confirmed IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'email_not_confirmed'); END IF;

    SELECT * INTO inv FROM link_parent_invites WHERE id = p_invite_id;
    IF inv.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invite_not_found'); END IF;

    -- The invite must be for MY email and not already owned by someone else.
    IF lower(inv.parent_email) <> v_email THEN
        RETURN jsonb_build_object('success', false, 'error', 'email_mismatch');
    END IF;
    IF inv.user_id IS NOT NULL AND inv.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;
    IF inv.status <> 'active' OR (inv.expires_at IS NOT NULL AND inv.expires_at <= now()) THEN
        RETURN jsonb_build_object('success', false, 'error', 'invite_inactive');
    END IF;

    UPDATE link_parent_invites SET user_id = caller WHERE id = p_invite_id;

    RETURN jsonb_build_object('success', true, 'camp_id', inv.camp_id, 'camper_names', inv.camper_names);
END;
$$;
REVOKE ALL ON FUNCTION public.connect_parent_invite(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.connect_parent_invite(uuid) TO authenticated;
