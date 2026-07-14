-- ============================================================================
-- Migration 034: Parent-invite lifecycle — offboarding + email changes
--
-- Closes three gaps in the roster-driven onboarding:
--   (a) A parent's LAST enrolled child is removed → their portal access must be
--       revoked (privacy/offboarding). Partial removals already self-heal via
--       the snapshot refresh.
--   (b) The camp changes a parent's email ON FILE → move the existing invite to
--       the new email IN PLACE (keep user_id/token/code) instead of orphaning it
--       and minting a duplicate.
--   (c) A PARENT changes their own login email → keep the invite's matching key
--       in sync so future auto-claims still find them.
-- ============================================================================

-- ─── (a) revoke_orphaned_parent_invites ──────────────────────────────────────
-- Revoke every active invite for the camp NONE of whose campers remain in the
-- roster. Safe by construction: an invite keeps access as long as ANY of its
-- children is still enrolled. No-ops if the roster list is empty (guards
-- against a mid-load call wiping everyone).
CREATE OR REPLACE FUNCTION public.revoke_orphaned_parent_invites(
    p_camp_id     uuid,
    p_roster_names jsonb          -- array of every camper name currently on the roster
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    n int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    -- Safety: never mass-revoke when we were handed an empty roster.
    IF p_roster_names IS NULL OR jsonb_typeof(p_roster_names) <> 'array' OR jsonb_array_length(p_roster_names) = 0 THEN
        RETURN jsonb_build_object('success', true, 'revoked', 0, 'skipped', 'empty_roster');
    END IF;

    WITH stale AS (
        SELECT i.id
        FROM link_parent_invites i
        WHERE i.camp_id = p_camp_id
          AND i.status = 'active'
          AND NOT EXISTS (
              -- any camper on this invite still present in the roster?
              SELECT 1
              FROM jsonb_array_elements_text(coalesce(i.camper_names, '[]'::jsonb)) cn
              WHERE p_roster_names ? cn
          )
    )
    UPDATE link_parent_invites SET status = 'revoked'
    WHERE id IN (SELECT id FROM stale);
    GET DIAGNOSTICS n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'revoked', n);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_orphaned_parent_invites(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.revoke_orphaned_parent_invites(uuid, jsonb) TO authenticated;

-- ─── (b) set_parent_invite_email — staff moves an invite to a new email ───────
-- Renames the parent_email of an existing active invite IN PLACE, preserving
-- user_id (the signed-up parent stays connected), token, and access code.
-- Refuses if an active invite already exists for the new email (conflict —
-- caller should merge manually).
CREATE OR REPLACE FUNCTION public.set_parent_invite_email(
    p_camp_id   uuid,
    p_old_email text,
    p_new_email text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    n int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    IF p_new_email IS NULL OR btrim(p_new_email) = '' OR p_old_email IS NULL OR btrim(p_old_email) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_email');
    END IF;
    IF lower(p_old_email) = lower(p_new_email) THEN
        RETURN jsonb_build_object('success', true, 'unchanged', true);
    END IF;

    IF EXISTS (
        SELECT 1 FROM link_parent_invites
        WHERE camp_id = p_camp_id AND lower(parent_email) = lower(p_new_email) AND status = 'active'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'target_email_exists');
    END IF;

    UPDATE link_parent_invites
    SET parent_email = p_new_email
    WHERE camp_id = p_camp_id AND lower(parent_email) = lower(p_old_email) AND status = 'active';
    GET DIAGNOSTICS n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'moved', n);
END;
$$;
REVOKE ALL ON FUNCTION public.set_parent_invite_email(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_parent_invite_email(uuid, text, text) TO authenticated;

-- ─── (c) sync_my_invite_email — parent keeps their match key current ──────────
-- After a parent changes their auth login email (supabase.auth.updateUser),
-- point every invite bound to their user_id at the new (confirmed) email, so
-- future claim_invites_by_email calls still resolve them.
CREATE OR REPLACE FUNCTION public.sync_my_invite_email()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    v_email text;
    v_confirmed timestamptz;
    n int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    SELECT lower(u.email), u.email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users u WHERE u.id = caller;
    IF v_email IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_email'); END IF;
    IF v_confirmed IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'email_not_confirmed'); END IF;

    UPDATE link_parent_invites
    SET parent_email = v_email
    WHERE user_id = caller AND status = 'active' AND lower(parent_email) <> v_email;
    GET DIAGNOSTICS n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'synced', n, 'email', v_email);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_my_invite_email() FROM public;
GRANT EXECUTE ON FUNCTION public.sync_my_invite_email() TO authenticated;
