-- ============================================================================
-- Migration: link_messages — cloud-backed admin <-> parent direct messaging
--
-- Why: the Campistry Link "Messages" feature (as opposed to Broadcasts, which
--      already persists correctly to link_broadcasts) had NO cloud
--      persistence at all. The admin's msg.send() (campistry_link_data.js)
--      only wrote to the admin's own browser localStorage. The parent portal
--      (campistry_link_parent.html) doesn't even load campistry_link_data.js
--      and has zero RPC calls for messages — it only ever reads its own
--      local campistry_link_v1 key. So a message sent by the admin was
--      structurally unable to ever reach a parent on a different device,
--      and a parent's reply could never reach the admin's inbox either.
--
-- link_outbox (migration 007) is NOT reused here — it's a one-way system
-- notification log (bus stop changes, bunk assignment, schedule notices)
-- with no direction/read/thread concept. This is a genuine two-way inbox,
-- so it gets its own table.
--
-- Admin side: authenticated camp-staff session, so direct table access
-- under RLS (same pattern as link_camper_mail/link_outbox) — no RPC needed
-- for admin reads/writes.
-- Parent side: no camp-staff session, so every parent-facing operation goes
-- through a SECURITY DEFINER RPC scoped to their own invite (same pattern
-- as submit_link_tip/submit_camper_mail/get_my_tips).
-- ============================================================================

-- ─── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_messages (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id       uuid        NOT NULL,
    thread_id     uuid        NOT NULL,   -- groups a message with its replies; the root message's own id
    direction     text        NOT NULL,   -- 'out' (admin -> parent) | 'in' (parent -> admin)
    parent_name   text,
    parent_email  text,                   -- primary join key: which parent/family this thread belongs to
    camper_name   text,
    subject       text        NOT NULL DEFAULT '',
    body          text        NOT NULL DEFAULT '',
    channels      jsonb       NOT NULL DEFAULT '["app"]',
    read          boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_messages_camp
    ON link_messages (camp_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_messages_camp_parent
    ON link_messages (camp_id, parent_email);

CREATE INDEX IF NOT EXISTS idx_link_messages_thread
    ON link_messages (thread_id);

-- ─── 2. RLS — camp staff read/write directly; parents via RPC only ───────────
ALTER TABLE link_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_messages_select ON link_messages;
CREATE POLICY link_messages_select ON link_messages
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_messages_insert ON link_messages;
CREATE POLICY link_messages_insert ON link_messages
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_messages_update ON link_messages;
CREATE POLICY link_messages_update ON link_messages
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- ─── 3. RPC: get_my_messages — parent reads their own thread(s) ──────────────
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
    LIMIT 200;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_messages() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_messages() TO authenticated;

-- ─── 4. RPC: submit_message_reply — parent sends a reply or a fresh message ──
-- p_thread_id NULL starts a new thread (its own id becomes the thread_id);
-- passing an existing thread_id groups this as a reply within that thread.
CREATE OR REPLACE FUNCTION public.submit_message_reply(
    p_thread_id uuid DEFAULT NULL,
    p_subject   text DEFAULT '',
    p_body      text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    new_id  uuid := gen_random_uuid();
    use_thread uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_body IS NULL OR btrim(p_body) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_body');
    END IF;
    IF length(p_body) > 10000 OR length(coalesce(p_subject,'')) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_long');
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

    -- A reply must reference a thread that actually belongs to this parent —
    -- otherwise start a fresh thread using the new row's own id.
    use_thread := new_id;
    IF p_thread_id IS NOT NULL THEN
        PERFORM 1 FROM link_messages
        WHERE thread_id = p_thread_id AND camp_id = inv.camp_id AND parent_email = inv.parent_email
        LIMIT 1;
        IF FOUND THEN use_thread := p_thread_id; END IF;
    END IF;

    INSERT INTO link_messages (
        id, camp_id, thread_id, direction, parent_name, parent_email, subject, body
    ) VALUES (
        new_id, inv.camp_id, use_thread, 'in', inv.parent_name, inv.parent_email,
        coalesce(p_subject, ''), p_body
    );

    RETURN jsonb_build_object('success', true, 'id', new_id, 'thread_id', use_thread);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_message_reply(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_message_reply(uuid, text, text) TO authenticated;

-- ─── 5. RPC: mark_message_read — parent marks an admin message as read ───────
CREATE OR REPLACE FUNCTION public.mark_message_read(p_message_id uuid)
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
    SET read = true
    WHERE id = p_message_id
      AND camp_id = inv.camp_id
      AND parent_email = inv.parent_email
      AND direction = 'out';

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_message_read(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_message_read(uuid) TO authenticated;

-- ─── 6. RPC: get_camp_broadcasts — parent reads camp-wide announcements ──────
-- link_broadcasts (migration 007) already gets written correctly by the
-- admin's msg.broadcast(); this was simply never read back by the parent
-- portal, which doesn't load campistry_link_data.js and has no RPC for it.
CREATE OR REPLACE FUNCTION public.get_camp_broadcasts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    result jsonb;
BEGIN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'subject', b.subject, 'body', b.body, 'created_at', b.created_at
    ) ORDER BY b.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_broadcasts b
    WHERE b.camp_id = p_camp_id
    LIMIT 100;

    RETURN jsonb_build_object('success', true, 'broadcasts', result);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_broadcasts(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_broadcasts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_camp_broadcasts(uuid) TO anon;

-- ─── 7. Realtime (optional, mirrors link_outbox/link_broadcasts) ─────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE link_messages;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- ─── 8. Sanity check ──────────────────────────────────────────────────────────
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('get_my_messages','submit_message_reply','mark_message_read','get_camp_broadcasts');
