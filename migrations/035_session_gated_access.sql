-- ============================================================================
-- Migration 035: Session-gated parent access.
--
-- A parent only sees a child, and only has portal access, while that child is
-- inside their ATTENDANCE WINDOW: [session start − onboarding lead] .. [session
-- end + photo grace]. Windows (accessStart/accessEnd, ISO dates) are stamped per
-- camper into camper_data by Campistry Me. Because they're absolute dates, access
-- expires by the calendar with no cron:
--   * a one-half camper's parent loses access after that half (+grace)
--   * a 2nd-half joiner appears when their window opens (start − lead)
--   * in a multi-child family, a child who has left simply drops out while the
--     others keep the parent connected
--
-- Backward-compatible: a camper with no accessStart/accessEnd is ALWAYS active,
-- so camps that don't use sessions are unaffected.
-- ============================================================================

-- ─── shared filter: keep only campers whose window includes today ─────────────
CREATE OR REPLACE FUNCTION public.link_filter_active_campers(p_names jsonb, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    k         text;
    v         jsonb;
    as_txt    text;
    ae_txt    text;
    is_active boolean;
    out_names jsonb := '[]'::jsonb;
    out_data  jsonb := '{}'::jsonb;
BEGIN
    FOR k IN SELECT jsonb_array_elements_text(coalesce(p_names, '[]'::jsonb)) LOOP
        v := CASE WHEN p_data IS NULL THEN NULL ELSE p_data->k END;
        as_txt := nullif(v->>'accessStart', '');
        ae_txt := nullif(v->>'accessEnd', '');
        BEGIN
            is_active := (as_txt IS NULL OR as_txt::date <= current_date)
                     AND (ae_txt IS NULL OR ae_txt::date >= current_date);
        EXCEPTION WHEN others THEN
            is_active := true;   -- malformed dates never lock a family out
        END;
        IF is_active THEN
            out_names := out_names || to_jsonb(k);
            IF v IS NOT NULL THEN out_data := out_data || jsonb_build_object(k, v); END IF;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('names', out_names, 'data', out_data, 'count', jsonb_array_length(out_names));
END;
$$;
REVOKE ALL ON FUNCTION public.link_filter_active_campers(jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.link_filter_active_campers(jsonb, jsonb) TO authenticated;

-- ─── get_parent_data_by_user — now session-gated ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_parent_data_by_user()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv      link_parent_invites;
    caller   uuid := auth.uid();
    filtered jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_invite_found'); END IF;

    filtered := public.link_filter_active_campers(inv.camper_names, inv.camper_data);
    IF (filtered->>'count')::int = 0 THEN
        -- Bound to a family, but none of the children are in session right now.
        RETURN jsonb_build_object('success', false, 'error', 'no_active_session');
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', filtered->'names',
        'camper_data',  filtered->'data'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_parent_data_by_user() FROM public;
GRANT EXECUTE ON FUNCTION public.get_parent_data_by_user() TO authenticated;

-- ─── claim_parent_invite — same session gate on the token path ───────────────
CREATE OR REPLACE FUNCTION public.claim_parent_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv      link_parent_invites;
    caller   uuid := auth.uid();
    filtered jsonb;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE token = p_token AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_or_expired'); END IF;
    IF inv.user_id IS NOT NULL AND inv.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    -- Bind the account regardless (so access opens automatically when the window
    -- does), but gate the DATA on the current session window.
    UPDATE link_parent_invites SET user_id = caller WHERE id = inv.id;

    filtered := public.link_filter_active_campers(inv.camper_names, inv.camper_data);
    IF (filtered->>'count')::int = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_session');
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', filtered->'names',
        'camper_data',  filtered->'data'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.claim_parent_invite(text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_parent_invite(text) TO authenticated;
