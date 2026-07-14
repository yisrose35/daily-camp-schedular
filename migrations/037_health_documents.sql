-- ============================================================================
-- Migration 037: Parent health-document uploads → Campistry Health (cloud sync)
--
-- Before: the parent portal wrote a health-doc record to localStorage on the
-- PARENT's device, and Campistry Health read localStorage on the NURSE's device
-- — two different stores, so the nurse never saw it (and the file itself was
-- never even captured). This adds a real cloud table + RPCs so an uploaded
-- document (with its bytes) reaches the nurse, who can approve/flag it.
--
-- File bytes are stored base64 in-DB (parent-resized/limited). TODO(scale): move
-- to a private Supabase Storage bucket if camps upload large volumes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.link_health_submissions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id       uuid        NOT NULL,
    camper_name   text        NOT NULL,
    file_name     text,
    file_type     text,
    file_data     text,                               -- base64 data URL
    note          text,
    status        text        NOT NULL DEFAULT 'pending',  -- pending|approved|flagged
    reviewed_by   uuid,
    reviewed_at   timestamptz,
    review_notes  text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.link_health_submissions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_link_health_submissions_camp ON public.link_health_submissions (camp_id, status);

-- staff (owner / camp_users) read+manage directly; parents go through RPCs
DO $$
BEGIN
    DROP POLICY IF EXISTS lhs_staff_all ON public.link_health_submissions;
    CREATE POLICY lhs_staff_all ON public.link_health_submissions FOR ALL
        USING (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_health_submissions.camp_id AND u.user_id = auth.uid())
        )
        WITH CHECK (
            EXISTS (SELECT 1 FROM camps c WHERE c.id = camp_id AND c.owner = auth.uid())
            OR EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = link_health_submissions.camp_id AND u.user_id = auth.uid())
        );
END $$;

-- ─── parent: submit a health document ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_health_document(
    p_camp_id     uuid,
    p_camper_name text,
    p_file_name   text,
    p_file_type   text,
    p_file_data   text,
    p_note        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); new_id uuid := gen_random_uuid();
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT public._parent_owns_camper(p_camp_id, p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;
    IF p_file_data IS NULL OR length(p_file_data) > 6000000 THEN   -- ~4.5MB base64 ceiling
        RETURN jsonb_build_object('success', false, 'error', 'bad_file');
    END IF;

    INSERT INTO link_health_submissions (id, camp_id, camper_name, file_name, file_type, file_data, note)
    VALUES (new_id, p_camp_id, p_camper_name, left(coalesce(p_file_name,''),200), left(coalesce(p_file_type,''),100),
            p_file_data, left(coalesce(p_note,''),1000));

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_health_document(uuid, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_health_document(uuid, text, text, text, text, text) TO authenticated;

-- ─── parent: list their own children's submitted docs (metadata only) ────────
CREATE OR REPLACE FUNCTION public.get_my_health_documents(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'camper_name', s.camper_name, 'file_name', s.file_name,
        'status', s.status, 'created_at', s.created_at
    ) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_health_submissions s
    WHERE s.camp_id = p_camp_id AND public._parent_owns_camper(p_camp_id, s.camper_name);
    RETURN jsonb_build_object('success', true, 'documents', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_health_documents(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_health_documents(uuid) TO authenticated;

-- ─── staff: list all parent-submitted docs for the camp (with file bytes) ────
CREATE OR REPLACE FUNCTION public.get_camp_health_documents(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'camper_name', s.camper_name, 'file_name', s.file_name,
        'file_type', s.file_type, 'file_data', s.file_data, 'note', s.note,
        'status', s.status, 'review_notes', s.review_notes,
        'reviewed_at', s.reviewed_at, 'created_at', s.created_at
    ) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_health_submissions s
    WHERE s.camp_id = p_camp_id;
    RETURN jsonb_build_object('success', true, 'documents', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_health_documents(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_health_documents(uuid) TO authenticated;

-- ─── staff: approve / flag a document ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_health_document_status(
    p_id     uuid,
    p_status text,
    p_notes  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE caller uuid := auth.uid(); v_camp uuid;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_status NOT IN ('pending','approved','flagged') THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_status');
    END IF;
    SELECT camp_id INTO v_camp FROM link_health_submissions WHERE id = p_id;
    IF v_camp IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = v_camp AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = v_camp AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    UPDATE link_health_submissions
    SET status = p_status, reviewed_by = caller, reviewed_at = now(),
        review_notes = coalesce(p_notes, review_notes)
    WHERE id = p_id;

    RETURN jsonb_build_object('success', true, 'status', p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.set_health_document_status(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_health_document_status(uuid, text, text) TO authenticated;
