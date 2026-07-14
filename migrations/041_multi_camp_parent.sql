-- ============================================================================
-- Migration 041: Multi-camp parents — see kids across different camps.
--
-- A parent whose children attend DIFFERENT camps is already linked to every
-- camp's invite (claim_invites_by_email binds them all). This RPC returns ALL of
-- those camps at once so the portal can show a combined view (each child tagged
-- with its camp), instead of get_parent_data_by_user which returns only the
-- single most-recent camp.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_camps()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    result jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'camp_id',      i.camp_id,
        'camp_name',    coalesce(NULLIF(btrim(c.name), ''), 'Camp'),
        'parent_name',  i.parent_name,
        'parent_email', i.parent_email,
        'family_id',    i.family_id,
        'camper_names', i.camper_names,
        'camper_data',  i.camper_data
    ) ORDER BY coalesce(c.name,''), i.created_at), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    LEFT JOIN camps c ON c.id = i.camp_id
    WHERE i.user_id = caller
      AND i.status = 'active'
      AND (i.expires_at IS NULL OR i.expires_at > now());

    RETURN jsonb_build_object('success', true, 'camps', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camps() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camps() TO authenticated;

-- ============================================================================
-- Camp-scoped invite resolution for form + camper-mail submits.
--
-- Both submit_link_form_response (013) and submit_camper_mail (015) resolved the
-- caller's invite as "the single most-recent one" (ORDER BY created_at DESC
-- LIMIT 1). For a parent with kids in DIFFERENT camps that silently files the
-- submission under the wrong camp. We add an optional trailing p_camp_id: when
-- present the invite is resolved for THAT camp; otherwise behaviour is unchanged
-- (most-recent). Adding p_camp_id as a trailing DEFAULT NULL keeps every existing
-- positional/named caller working (the old 12-/6-arg calls resolve to these).
-- ============================================================================

-- ── submit_link_form_response (+ p_camp_id) ─────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text);
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
    p_bunk         text     DEFAULT NULL,
    p_camp_id      text     DEFAULT NULL
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
REVOKE ALL ON FUNCTION public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_link_form_response(text, text, text, text, text, jsonb, text, text, text, text, text, text, text) TO authenticated;

-- ── submit_camper_mail (+ p_camp_id) ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_camper_mail(text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.submit_camper_mail(
    p_camper_name text,
    p_subject     text DEFAULT '',
    p_body        text DEFAULT '',
    p_division    text DEFAULT NULL,
    p_grade       text DEFAULT NULL,
    p_bunk        text DEFAULT NULL,
    p_camp_id     text DEFAULT NULL
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
REVOKE ALL ON FUNCTION public.submit_camper_mail(text, text, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_camper_mail(text, text, text, text, text, text, text) TO authenticated;
