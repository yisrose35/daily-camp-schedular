-- ============================================================================
-- Migration: staff per-PRODUCT access + parent -> named-staff message routing
--
-- Extends the existing camp_users RBAC (owner/admin/scheduler/viewer/counselor)
-- so the OWNER can grant each staff member access to specific PARTS of the site
-- (Go, Health, Snacks, Live, Link, Me, Flow) and mark them parent-contactable
-- with a public department label (e.g. Rabbi A — Bussing, Mrs B — Nurse).
--
-- Parents then pick one or more of those staff when composing a message, and it
-- routes to those people's inboxes (multi-select = a group message).
-- ============================================================================

-- ─── 1. camp_users: product access + parent-facing directory fields ───────────
ALTER TABLE public.camp_users
    ADD COLUMN IF NOT EXISTS product_access      jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- e.g. ["go","health"]
    ADD COLUMN IF NOT EXISTS display_name        text,
    ADD COLUMN IF NOT EXISTS department          text,                                  -- parent-facing label
    ADD COLUMN IF NOT EXISTS parent_contactable  boolean NOT NULL DEFAULT false;

-- ─── 2. link_messages: route a message to a specific staff member ─────────────
ALTER TABLE public.link_messages
    ADD COLUMN IF NOT EXISTS recipient_user_id uuid,   -- NULL = general camp office
    ADD COLUMN IF NOT EXISTS recipient_label   text;   -- what the parent picked (dept/name)

CREATE INDEX IF NOT EXISTS idx_link_messages_recipient
    ON public.link_messages (camp_id, recipient_user_id);

-- A staff member may read the messages routed to them (in addition to whatever
-- owner/admin policies already allow).
DROP POLICY IF EXISTS link_messages_staff_recipient ON public.link_messages;
CREATE POLICY link_messages_staff_recipient ON public.link_messages
    FOR SELECT USING (recipient_user_id = auth.uid());

-- ─── 3. get_camp_contacts — the parent's recipient directory ──────────────────
-- Returns the staff the owner marked parent_contactable, for a parent of the
-- camp. Camp-aware (a parent may belong to more than one camp).
CREATE OR REPLACE FUNCTION public.get_camp_contacts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    -- Must be an active parent (or a staff member) of this camp.
    IF NOT EXISTS (
        SELECT 1 FROM link_parent_invites i
        WHERE i.user_id = caller AND i.camp_id = p_camp_id AND i.status = 'active'
    ) AND NOT EXISTS (
        SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller
    ) AND NOT EXISTS (
        SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'user_id',    u.user_id,
        'name',       coalesce(u.display_name, 'Staff'),
        'department', coalesce(u.department, '')
    ) ORDER BY u.department NULLS LAST, u.display_name), '[]'::jsonb)
    INTO result
    FROM camp_users u
    WHERE u.camp_id = p_camp_id AND u.parent_contactable = true AND u.display_name IS NOT NULL;

    RETURN jsonb_build_object('success', true, 'contacts', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_contacts(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_contacts(uuid) TO authenticated;

-- ─── 4. submit_parent_message — parent -> chosen staff (one or many) ──────────
-- p_recipients is a jsonb array of {user_id, label}. Empty/NULL routes to the
-- general office (recipient_user_id NULL), preserving today's behaviour. One
-- link_messages row is written per recipient so each staff inbox gets it and the
-- parent's own thread stays coherent (shared thread_id).
CREATE OR REPLACE FUNCTION public.submit_parent_message(
    p_camp_id    uuid,
    p_subject    text,
    p_body       text,
    p_recipients jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    thread    uuid := gen_random_uuid();
    rec       jsonb;
    n         int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_body IS NULL OR btrim(p_body) = '' THEN RETURN jsonb_build_object('success', false, 'error', 'missing_body'); END IF;
    IF length(p_body) > 10000 OR length(coalesce(p_subject,'')) > 200 THEN RETURN jsonb_build_object('success', false, 'error', 'too_long'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND camp_id = p_camp_id
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    IF p_recipients IS NULL OR jsonb_array_length(p_recipients) = 0 THEN
        INSERT INTO link_messages (id, camp_id, thread_id, direction, parent_name, parent_email, subject, body)
        VALUES (gen_random_uuid(), inv.camp_id, thread, 'in', inv.parent_name, inv.parent_email, coalesce(p_subject,''), p_body);
        n := 1;
    ELSE
        FOR rec IN SELECT * FROM jsonb_array_elements(p_recipients) LOOP
            INSERT INTO link_messages (id, camp_id, thread_id, direction, parent_name, parent_email, subject, body, recipient_user_id, recipient_label)
            VALUES (gen_random_uuid(), inv.camp_id, thread, 'in', inv.parent_name, inv.parent_email, coalesce(p_subject,''), p_body,
                    NULLIF(rec->>'user_id','')::uuid, rec->>'label');
            n := n + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success', true, 'thread_id', thread, 'sent', n);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_parent_message(uuid, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_parent_message(uuid, text, text, jsonb) TO authenticated;

-- ─── 5. get_staff_messages — a staff member's routed inbox ────────────────────
CREATE OR REPLACE FUNCTION public.get_staff_messages(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller)
       AND NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'thread_id', m.thread_id, 'subject', m.subject, 'body', m.body,
        'parent_name', m.parent_name, 'parent_email', m.parent_email,
        'recipient_label', m.recipient_label, 'read', m.read, 'created_at', m.created_at
    ) ORDER BY m.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_messages m
    WHERE m.camp_id = p_camp_id AND m.recipient_user_id = caller AND m.direction = 'in'
    LIMIT 300;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_staff_messages(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_staff_messages(uuid) TO authenticated;
