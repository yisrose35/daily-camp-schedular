-- ============================================================================
-- Migration 038: Message routing correctness fixes.
--
-- Fixes (server side):
--   HOLE 4 — a parent's reply in a thread that was routed to a NAMED STAFF
--            member used to reset recipient_user_id = NULL (→ office), so the
--            staffer never saw the follow-up. Now the reply INHERITS the
--            thread's staff recipient, keeping the conversation with that staffer.
--   HOLE 5 — a parent's group message (one row per recipient) showed up N times
--            in the parent's own inbox. get_my_messages now DEDUPES identical
--            rows (same thread/direction/time) to a single entry.
--   HOLE 8 — parent_email match is now case-insensitive (lower()) so a case
--            mismatch between the invite email and a message row can't silently
--            hide messages.
--   ATTRIBUTION — get_my_messages now returns camper_name + recipient_label so
--            the parent can see which child / which staffer a thread concerns.
-- (Client-side fixes for admin-reply parent_email/thread_id, the office-inbox
--  routed-message filter, and the multi-camp reply p_camp_id ride alongside.)
-- ============================================================================

-- ─── submit_message_reply: preserve the thread's staff recipient ─────────────
CREATE OR REPLACE FUNCTION public.submit_message_reply(
    p_thread_id uuid DEFAULT NULL,
    p_subject   text DEFAULT '',
    p_body      text DEFAULT '',
    p_camp_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    new_id     uuid := gen_random_uuid();
    use_thread uuid;
    v_recip    uuid := NULL;
    v_label    text := NULL;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_body IS NULL OR btrim(p_body) = '' THEN RETURN jsonb_build_object('success', false, 'error', 'missing_body'); END IF;
    IF length(p_body) > 10000 OR length(coalesce(p_subject,'')) > 200 THEN RETURN jsonb_build_object('success', false, 'error', 'too_long'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    use_thread := new_id;
    IF p_thread_id IS NOT NULL THEN
        PERFORM 1 FROM link_messages
        WHERE thread_id = p_thread_id AND camp_id = inv.camp_id
          AND lower(parent_email) = lower(inv.parent_email) LIMIT 1;
        IF FOUND THEN
            use_thread := p_thread_id;
            -- Inherit the staff recipient this thread was routed to (if any), so
            -- the follow-up goes back to the same staffer, not the office.
            SELECT recipient_user_id, recipient_label INTO v_recip, v_label
            FROM link_messages
            WHERE thread_id = use_thread AND camp_id = inv.camp_id AND recipient_user_id IS NOT NULL
            ORDER BY created_at ASC LIMIT 1;
        END IF;
    END IF;

    INSERT INTO link_messages (
        id, camp_id, thread_id, direction, parent_name, parent_email, subject, body,
        recipient_user_id, recipient_label
    ) VALUES (
        new_id, inv.camp_id, use_thread, 'in', inv.parent_name, inv.parent_email,
        coalesce(p_subject,''), p_body, v_recip, v_label
    );

    RETURN jsonb_build_object('success', true, 'id', new_id, 'thread_id', use_thread);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_message_reply(uuid, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_message_reply(uuid, text, text, uuid) TO authenticated;

-- ─── get_my_messages: dedupe group copies, case-insensitive, + attribution ───
CREATE OR REPLACE FUNCTION public.get_my_messages(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    WITH deduped AS (
        SELECT DISTINCT ON (m.thread_id, m.direction, m.created_at)
               m.id, m.thread_id, m.direction, m.subject, m.body, m.read,
               m.archived_for_parent, m.camper_name, m.recipient_label, m.created_at
        FROM link_messages m
        WHERE m.camp_id = inv.camp_id
          AND lower(m.parent_email) = lower(inv.parent_email)
          AND m.hidden_for_parent = false
        ORDER BY m.thread_id, m.direction, m.created_at, m.id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',         id,
        'thread_id',  thread_id,
        'direction',  direction,
        'subject',    subject,
        'body',       body,
        'read',       read,
        'archived',   archived_for_parent,
        'camper',     camper_name,
        'to',         recipient_label,
        'created_at', created_at
    ) ORDER BY created_at DESC), '[]'::jsonb)
    INTO result FROM deduped;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_messages(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_messages(uuid) TO authenticated;
