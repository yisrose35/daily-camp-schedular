-- ============================================================================
-- Migration: link_form_responses — cloud recording of parent form submissions
--
-- Why: parent form submissions (fill-online and print & return uploads) were
--      stored only in the parent's browser localStorage, so they never reached
--      the camp admin from another device. This table records every response
--      in the cloud — Google-Forms style — so the admin portal can list them,
--      view them, and export them to Excel / Google Sheets.
--
-- Write path (parents): submit_link_form_response() RPC — SECURITY DEFINER.
--      The parent portal always has an authenticated Supabase session by the
--      time forms load (invite claim / access-code link both require auth),
--      so the RPC resolves the caller's invite via auth.uid() and never
--      trusts client-supplied camp_id or parent identity.
--
-- Read path (parents): get_my_form_responses() RPC — returns the caller's own
--      submissions so "Submitted" badges survive across devices.
--
-- Read path (admins): direct SELECT under camp-staff RLS (same pattern as
--      link_outbox in migration 007).
--
-- Re-submission model: one live response per (invite, form, camper) — a
--      re-submission replaces the previous one (camp forms are documents of
--      record, not survey entries).
-- ============================================================================

-- ─── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link_form_responses (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id        uuid        NOT NULL,
    invite_id      uuid,                     -- link_parent_invites.id of the submitter
    user_id        uuid,                     -- auth.users.id of the submitter
    form_id        text        NOT NULL,     -- lfd_* (built) or lfp_* (print & return)
    form_name      text        NOT NULL DEFAULT '',
    mode           text        NOT NULL DEFAULT 'digital',  -- digital | upload
    camper_name    text        NOT NULL DEFAULT '',
    camper_id      text,
    parent_name    text,
    parent_email   text,
    division       text,
    grade          text,
    bunk           text,
    answers        jsonb       NOT NULL DEFAULT '{}',       -- { "Question label": "answer" }
    signature_data text,                     -- PNG data URL from the signature canvas
    file_name      text,                     -- print & return: original file name
    file_data      text,                     -- print & return: data URL of the uploaded file
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_form_responses_camp
    ON link_form_responses (camp_id);

CREATE INDEX IF NOT EXISTS idx_link_form_responses_camp_form
    ON link_form_responses (camp_id, form_id);

CREATE INDEX IF NOT EXISTS idx_link_form_responses_invite
    ON link_form_responses (invite_id);

-- ─── 2. RLS — camp staff read/manage; parents write via RPC only ─────────────
ALTER TABLE link_form_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_form_responses_select ON link_form_responses;
CREATE POLICY link_form_responses_select ON link_form_responses
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_form_responses_delete ON link_form_responses;
CREATE POLICY link_form_responses_delete ON link_form_responses
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- No INSERT/UPDATE policies: parents write through the SECURITY DEFINER RPC,
-- admins never write rows directly.

-- ─── 3. RPC: submit_link_form_response ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_link_form_response(
    p_form_id      text,
    p_form_name    text,
    p_mode         text,
    p_camper_name  text,
    p_camper_id    text     DEFAULT NULL,
    p_answers      jsonb    DEFAULT '{}',
    p_signature    text     DEFAULT NULL,
    p_file_name    text     DEFAULT NULL,
    p_file_data    text     DEFAULT NULL,
    p_division     text     DEFAULT NULL,
    p_grade        text     DEFAULT NULL,
    p_bunk         text     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_form_id IS NULL OR p_form_id = '' OR p_camper_name IS NULL OR p_camper_name = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;

    -- Size guards: answers 256 KB, signature 1 MB, file 6 MB (≈4 MB binary as base64)
    IF length(coalesce(p_answers::text, '')) > 262144 THEN
        RETURN jsonb_build_object('success', false, 'error', 'answers_too_large');
    END IF;
    IF length(coalesce(p_signature, '')) > 1048576 THEN
        RETURN jsonb_build_object('success', false, 'error', 'signature_too_large');
    END IF;
    IF length(coalesce(p_file_data, '')) > 6291456 THEN
        RETURN jsonb_build_object('success', false, 'error', 'file_too_large');
    END IF;

    -- Resolve the caller's invite (the credential that scopes them to a camp)
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

    -- The camper must belong to this invite
    IF inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- Replace any previous submission for the same form + camper by this family
    DELETE FROM link_form_responses
    WHERE invite_id = inv.id
      AND form_id = p_form_id
      AND camper_name = p_camper_name;

    INSERT INTO link_form_responses (
        camp_id, invite_id, user_id, form_id, form_name, mode,
        camper_name, camper_id, parent_name, parent_email,
        division, grade, bunk, answers, signature_data, file_name, file_data
    ) VALUES (
        inv.camp_id, inv.id, caller, p_form_id, coalesce(p_form_name, ''),
        CASE WHEN p_mode = 'upload' THEN 'upload' ELSE 'digital' END,
        p_camper_name, p_camper_id, inv.parent_name, inv.parent_email,
        p_division, p_grade, p_bunk,
        coalesce(p_answers, '{}'::jsonb), p_signature, p_file_name, p_file_data
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text) TO authenticated;

-- ─── 4. RPC: get_my_form_responses ────────────────────────────────────────────
-- Lightweight list (no file/signature payloads) so the parent portal can show
-- "Submitted" state on any device.
CREATE OR REPLACE FUNCTION public.get_my_form_responses()
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
        'id',          r.id,
        'form_id',     r.form_id,
        'form_name',   r.form_name,
        'mode',        r.mode,
        'camper_name', r.camper_name,
        'created_at',  r.created_at
    ) ORDER BY r.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_form_responses r
    WHERE r.user_id = caller;

    RETURN jsonb_build_object('success', true, 'responses', result);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_form_responses() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_form_responses() TO authenticated;

-- ─── 5. Sanity check ──────────────────────────────────────────────────────────
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename = 'link_form_responses' AND schemaname = 'public';
--
--   SELECT proname, prosecdef FROM pg_proc
--   WHERE proname IN ('submit_link_form_response', 'get_my_form_responses');
-- ============================================================================
