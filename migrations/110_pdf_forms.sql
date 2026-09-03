-- =============================================================================
-- Migration 110: Fillable PDF Forms — parents fill out real camp PDFs in the
-- browser (see /root/.claude/plans/bubbly-jingling-kite.md for the full design).
--
-- Camps upload a PDF that already has real embedded AcroForm fields (exported
-- from Adobe/DocuSign/JotForm/etc.); the app auto-detects the fields
-- client-side (pdf-lib) and the camp reviews/labels them. Parents fill the
-- real PDF in the browser (pdf.js render + overlay inputs), sign with the
-- existing signature pad, and pdf-lib stamps + flattens a real completed PDF
-- client-side before it's uploaded.
--
-- This slots into the EXISTING "Digital Forms" system rather than building a
-- new one: linkForms.digital[] (camp_state_kv key 'link_forms', read via
-- get_link_camp_forms — migration 012) gains a sourceType:'pdf' entry with a
-- fieldSchema built from detection; submission tracking reuses
-- link_form_responses / submit_link_form_response (migration 013, extended
-- by 041 with p_camp_id) unchanged apart from one new trailing pointer
-- column/param for the filled PDF's Storage path.
--
-- Storage RLS follows the exact "private bucket, staff-only INSERT scoped by
-- camp_id folder, deny-all SELECT/UPDATE/DELETE — every read goes through a
-- service-role edge function minting short-lived signed URLs" pattern
-- already established for camp-photos (migration 080).
-- =============================================================================

-- ─── 1. New private bucket: camp-pdf-forms ──────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('camp-pdf-forms', 'camp-pdf-forms', false)
ON CONFLICT (id) DO NOTHING;

-- Paths: {camp_id}/templates/{formId}.pdf  and  {camp_id}/submissions/{responseId}.pdf
-- storage.foldername(name)[1] is the camp_id segment. INSERT is staff-only
-- for templates (camps upload via the client, same direct-upload pattern
-- campistry_link_photos.js already uses for staff photo uploads); submission
-- PDFs are written by the submit-pdf-form-response edge function using the
-- service-role key, which bypasses RLS entirely, so no parent-facing INSERT
-- policy is needed or granted. No SELECT/UPDATE/DELETE policy exists for
-- anyone — every read goes through get-pdf-form-urls (service-role, signed
-- URLs), matching camp-photos exactly.
DROP POLICY IF EXISTS camp_pdf_forms_staff_insert ON storage.objects;
CREATE POLICY camp_pdf_forms_staff_insert ON storage.objects
    FOR INSERT
    WITH CHECK (
        bucket_id = 'camp-pdf-forms'
        AND (
            EXISTS (
                SELECT 1 FROM camps c
                WHERE c.id::text = (storage.foldername(name))[1] AND c.owner = auth.uid()
            )
            OR EXISTS (
                SELECT 1 FROM camp_users u
                WHERE u.camp_id::text = (storage.foldername(name))[1] AND u.user_id = auth.uid()
            )
        )
    );

-- ─── 2. link_form_responses: pointer column for the filled PDF ─────────────
ALTER TABLE public.link_form_responses
    ADD COLUMN IF NOT EXISTS filled_pdf_path text;

-- ─── 3. submit_link_form_response — one new trailing param ─────────────────
-- Same signature as migration 041 plus p_filled_pdf_path (DEFAULT NULL,
-- backward compatible with every existing caller — the client always calls
-- this RPC with named args, so a new trailing param needs no changes to
-- unrelated call sites).
DROP FUNCTION IF EXISTS public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.submit_link_form_response(
    p_form_id          text,
    p_form_name        text,
    p_mode             text,
    p_camper_name      text,
    p_camper_id        text     DEFAULT NULL,
    p_answers          jsonb    DEFAULT '{}',
    p_signature        text     DEFAULT NULL,
    p_file_name        text     DEFAULT NULL,
    p_file_data        text     DEFAULT NULL,
    p_division         text     DEFAULT NULL,
    p_grade            text     DEFAULT NULL,
    p_bunk             text     DEFAULT NULL,
    p_camp_id          text     DEFAULT NULL,
    p_filled_pdf_path  text     DEFAULT NULL
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

    IF length(coalesce(p_answers::text, '')) > 262144 THEN
        RETURN jsonb_build_object('success', false, 'error', 'answers_too_large');
    END IF;
    IF length(coalesce(p_signature, '')) > 1048576 THEN
        RETURN jsonb_build_object('success', false, 'error', 'signature_too_large');
    END IF;
    IF length(coalesce(p_file_data, '')) > 6291456 THEN
        RETURN jsonb_build_object('success', false, 'error', 'file_too_large');
    END IF;
    IF length(coalesce(p_filled_pdf_path, '')) > 512 THEN
        RETURN jsonb_build_object('success', false, 'error', 'path_too_long');
    END IF;

    -- Prefer the invite for the requested camp (multi-camp); else most-recent.
    IF p_camp_id IS NOT NULL AND btrim(p_camp_id) <> '' THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND camp_id = p_camp_id::uuid
        ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF inv.id IS NULL THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    IF inv.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    DELETE FROM link_form_responses
    WHERE invite_id = inv.id
      AND form_id = p_form_id
      AND camper_name = p_camper_name;

    INSERT INTO link_form_responses (
        camp_id, invite_id, user_id, form_id, form_name, mode,
        camper_name, camper_id, parent_name, parent_email,
        division, grade, bunk, answers, signature_data, file_name, file_data,
        filled_pdf_path
    ) VALUES (
        inv.camp_id, inv.id, caller, p_form_id, coalesce(p_form_name, ''),
        CASE WHEN p_mode = 'upload' THEN 'upload' ELSE 'digital' END,
        p_camper_name, p_camper_id, inv.parent_name, inv.parent_email,
        p_division, p_grade, p_bunk,
        coalesce(p_answers, '{}'::jsonb), p_signature, p_file_name, p_file_data,
        p_filled_pdf_path
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text, text, text) TO authenticated;

-- ─── 4. verify_my_camper — thin ownership check for the edge functions ────
-- Both submit-pdf-form-response (parent, checking they may submit for this
-- camper) and future callers can reuse this instead of re-deriving the
-- invite/camper_names ownership logic in TypeScript. Mirrors the same
-- camper_names ? p_camper_name check submit_link_form_response already does.
CREATE OR REPLACE FUNCTION public.verify_my_camper(p_camp_id text, p_camper_name text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
BEGIN
    IF caller IS NULL OR p_camper_name IS NULL OR p_camper_name = '' THEN
        RETURN false;
    END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR btrim(p_camp_id) = '' OR camp_id = p_camp_id::uuid)
    ORDER BY created_at DESC LIMIT 1;

    IF inv.id IS NULL THEN
        RETURN false;
    END IF;

    RETURN inv.camper_names IS NULL OR (inv.camper_names ? p_camper_name);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_my_camper(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_my_camper(text, text) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select id from storage.buckets where id = 'camp-pdf-forms';
--   select column_name from information_schema.columns
--     where table_name = 'link_form_responses' and column_name = 'filled_pdf_path';
--   select proname, pronargs from pg_proc where proname = 'submit_link_form_response';
--   select proname from pg_proc where proname = 'verify_my_camper';
-- =============================================================================
