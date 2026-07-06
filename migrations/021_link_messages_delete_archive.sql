-- ============================================================================
-- Migration: delete/archive/important for link_messages
--
-- Delete is per-party, not a shared hard delete: if a parent deletes a
-- message, it should disappear from THEIR inbox without destroying the
-- admin's own record of the conversation (and vice versa) — same
-- expectation as every email/messaging inbox. So:
--   - Admin delete = a real DELETE (admin owns the camp's data outright).
--   - Parent delete = a soft hide (hidden_for_parent), row stays intact for
--     the admin's records; get_my_messages() simply excludes it.
--
-- archived / important are admin-only concepts (organizing their own
-- inbox), so they're plain columns updatable via the existing admin UPDATE
-- policy — no new RPC needed for those.
-- ============================================================================

ALTER TABLE link_messages
    ADD COLUMN IF NOT EXISTS archived          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS important          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS hidden_for_parent   boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_link_messages_camp_archived
    ON link_messages (camp_id, archived);

-- ─── Admin delete policy (owner/admin only — matches link_camper_mail_delete /
-- link_form_responses_delete scoping, scheduler excluded) ────────────────────
DROP POLICY IF EXISTS link_messages_delete ON link_messages;
CREATE POLICY link_messages_delete ON link_messages
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── RPC: delete_my_message — parent hides a message from their own inbox ────
CREATE OR REPLACE FUNCTION public.delete_my_message(p_message_id uuid)
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
    SET hidden_for_parent = true
    WHERE id = p_message_id
      AND camp_id = inv.camp_id
      AND parent_email = inv.parent_email;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_message(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_my_message(uuid) TO authenticated;

-- ─── get_my_messages: exclude anything the parent has hidden ─────────────────
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
--   WHERE table_name = 'link_messages' AND column_name IN ('archived','important','hidden_for_parent');
--   SELECT proname FROM pg_proc WHERE proname = 'delete_my_message';
