-- =============================================================================
-- Migration 111: Fillable PDF Forms — authorization RPCs for get-pdf-form-urls
--
-- The camp-pdf-forms bucket (migration 110) denies all direct client reads —
-- every read goes through the get-pdf-form-urls edge function, which needs a
-- server-side way to answer "may this caller see this camp's PDF template /
-- this specific submission's filled PDF" without trusting the client. Unlike
-- link_photos (a real table with per-row RLS get-photo-urls can lean on),
-- PDF form templates live in the linkForms.digital[] JSON blob
-- (camp_state_kv key 'link_forms') — there's no table row to check RLS
-- against, so this is a small SECURITY DEFINER RPC instead, mirroring the
-- membership checks already used throughout (save_scanned_photo, etc.).
-- =============================================================================

-- ─── 1. can_access_pdf_form_template — staff OR any invited parent of the camp ──
-- Templates aren't camper-specific — any invited parent of the camp may view
-- any of that camp's PDF form templates (same as they can already see the
-- form's name/description via get_link_camp_forms).
CREATE OR REPLACE FUNCTION public.can_access_pdf_form_template(p_camp_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid();
BEGIN
    IF caller IS NULL OR p_camp_id IS NULL THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller) THEN RETURN true; END IF;
    IF EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN RETURN true; END IF;
    IF EXISTS (
        SELECT 1 FROM link_parent_invites i
        WHERE i.camp_id = p_camp_id AND i.user_id = caller AND i.status = 'active'
          AND (i.expires_at IS NULL OR i.expires_at > now())
    ) THEN RETURN true; END IF;
    RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.can_access_pdf_form_template(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_access_pdf_form_template(uuid) TO authenticated;

-- ─── 2. get_pdf_form_response_path — staff-only, for the office download action ─
-- Returns filled_pdf_path for a submission if the caller is staff of that
-- response's camp; NULL otherwise (never raises, so the edge function can
-- treat NULL the same as "not found" without leaking which is which).
CREATE OR REPLACE FUNCTION public.get_pdf_form_response_path(p_response_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    r      link_form_responses;
BEGIN
    IF caller IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO r FROM link_form_responses WHERE id = p_response_id;
    IF r.id IS NULL THEN RETURN NULL; END IF;
    IF NOT (
        EXISTS (SELECT 1 FROM camps c WHERE c.id = r.camp_id AND c.owner = caller)
        OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = r.camp_id AND u.user_id = caller
                     AND u.role IN ('owner','admin','scheduler'))
    ) THEN
        RETURN NULL;
    END IF;
    RETURN r.filled_pdf_path;
END;
$$;
REVOKE ALL ON FUNCTION public.get_pdf_form_response_path(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_pdf_form_response_path(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select proname from pg_proc where proname in
--     ('can_access_pdf_form_template','get_pdf_form_response_path');
-- =============================================================================
