-- ============================================================================
-- Migration: link_camper_mail — letters from parents to their campers
--
-- Parents write a letter to their child in the parent portal; the camp
-- office sees it in the Link admin portal, prints it (one letter per page),
-- and hands it to the camper. Status tracks the print workflow so parents
-- can see "Printed" and the office doesn't print a letter twice.
--
-- Write path (parents): submit_camper_mail() RPC — SECURITY DEFINER, resolves
--      the caller's invite via auth.uid() (same pattern as migration 013),
--      validates the camper is on the invite, size guards, daily cap.
-- Read path (parents): get_my_camper_mail() — own letters + status.
-- Read/manage path (admins): direct SELECT/UPDATE/DELETE under camp-staff
--      RLS (UPDATE marks letters printed).
-- ============================================================================

-- ─── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_camper_mail (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    invite_id    uuid,
    user_id      uuid,
    camper_name  text        NOT NULL,
    division     text,
    grade        text,
    bunk         text,
    parent_name  text,
    parent_email text,
    subject      text        NOT NULL DEFAULT '',
    body         text        NOT NULL,
    status       text        NOT NULL DEFAULT 'new',   -- new | printed
    created_at   timestamptz NOT NULL DEFAULT now(),
    printed_at   timestamptz,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_camper_mail_camp
    ON link_camper_mail (camp_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_camper_mail_camp_status
    ON link_camper_mail (camp_id, status);

CREATE INDEX IF NOT EXISTS idx_link_camper_mail_user
    ON link_camper_mail (user_id);

-- ─── 2. RLS — camp staff read/update/delete; parents write via RPC ───────────
ALTER TABLE link_camper_mail ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_camper_mail_select ON link_camper_mail;
CREATE POLICY link_camper_mail_select ON link_camper_mail
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_camper_mail_update ON link_camper_mail;
CREATE POLICY link_camper_mail_update ON link_camper_mail
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

DROP POLICY IF EXISTS link_camper_mail_delete ON link_camper_mail;
CREATE POLICY link_camper_mail_delete ON link_camper_mail
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- ─── 3. RPC: submit_camper_mail ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_camper_mail(
    p_camper_name text,
    p_subject     text DEFAULT '',
    p_body        text DEFAULT '',
    p_division    text DEFAULT NULL,
    p_grade       text DEFAULT NULL,
    p_bunk        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    n_today integer;
    new_id  uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR p_camper_name = '' OR p_body IS NULL OR length(btrim(p_body)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;
    IF length(p_body) > 20000 OR length(coalesce(p_subject, '')) > 200 THEN
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

    IF inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- Daily cap per family — keeps the print queue sane
    SELECT count(*) INTO n_today
    FROM link_camper_mail
    WHERE invite_id = inv.id
      AND created_at > now() - interval '24 hours';
    IF n_today >= 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'daily_limit_reached');
    END IF;

    INSERT INTO link_camper_mail (
        camp_id, invite_id, user_id, camper_name, division, grade, bunk,
        parent_name, parent_email, subject, body
    ) VALUES (
        inv.camp_id, inv.id, caller, p_camper_name, p_division, p_grade, p_bunk,
        inv.parent_name, inv.parent_email, coalesce(p_subject, ''), p_body
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_camper_mail(text, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_camper_mail(text, text, text, text, text, text) TO authenticated;

-- ─── 4. RPC: get_my_camper_mail ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_camper_mail()
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

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',          m.id,
        'camper_name', m.camper_name,
        'subject',     m.subject,
        'body',        m.body,
        'status',      m.status,
        'created_at',  m.created_at,
        'printed_at',  m.printed_at
    ) ORDER BY m.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_camper_mail m
    WHERE m.user_id = caller;

    RETURN jsonb_build_object('success', true, 'mail', result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_camper_mail() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camper_mail() TO authenticated;

-- ─── 5. Sanity check ──────────────────────────────────────────────────────────
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename = 'link_camper_mail' AND schemaname = 'public';
-- ============================================================================
