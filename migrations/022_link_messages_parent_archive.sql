-- ============================================================================
-- Migration: per-parent archive for link_messages
--
-- Migration 021 made archived/important admin-only concepts and gave parents
-- only a per-party delete (hidden_for_parent). Parents now also want to
-- archive a message out of their inbox without deleting it — the same
-- personal inbox-organization action, kept separate from the admin's own
-- `archived` column so the two sides never step on each other.
--
--   - archived_for_parent: per-parent archive flag (mirrors hidden_for_parent).
--   - set_my_message_archived(): parent toggles their own archive flag.
--   - get_my_messages(): now returns the archived flag AND keeps hidden rows
--     excluded, so the parent portal can show an Archived tab without a
--     second round-trip.
-- ============================================================================

ALTER TABLE link_messages
    ADD COLUMN IF NOT EXISTS archived_for_parent boolean NOT NULL DEFAULT false;

-- ─── RPC: set_my_message_archived — parent archives/unarchives their own row ──
CREATE OR REPLACE FUNCTION public.set_my_message_archived(p_message_id uuid, p_archived boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    UPDATE link_messages
    SET archived_for_parent = coalesce(p_archived, false)
    WHERE id = p_message_id
      AND camp_id = inv.camp_id
      AND parent_email = inv.parent_email;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_message_archived(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_my_message_archived(uuid, boolean) TO authenticated;

-- ─── get_my_messages: expose the parent archive flag, keep hidden rows out ────
CREATE OR REPLACE FUNCTION public.get_my_messages()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    result jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',         m.id,
        'thread_id',  m.thread_id,
        'direction',  m.direction,
        'subject',    m.subject,
        'body',       m.body,
        'read',       m.read,
        'archived',   m.archived_for_parent,
        'created_at', m.created_at
    ) ORDER BY m.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_messages m
    WHERE m.camp_id = inv.camp_id
      AND m.parent_email = inv.parent_email
      AND m.hidden_for_parent = false
    LIMIT 200;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;

-- ─── Sanity check ─────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'link_messages' AND column_name = 'archived_for_parent';
--   SELECT proname FROM pg_proc WHERE proname = 'set_my_message_archived';
