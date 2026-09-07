-- ============================================================================
-- Migration 124: stop showing a disconnected family's departed camper as a
-- normal "My Children" card.
--
-- Migrations 122/123 deliberately froze camper_names/camper_data on a
-- disconnected invite forever, so billing (get_my_balance) and photos keep
-- matching by name — the owner's explicit call: "we don't keep matching,
-- whatever is there is there and that's it." But the parent-side client
-- builds its "My Children" list straight from that same camper_data with
-- no awareness of camp_connected at all, in two places:
--
--   - _applyData(d) (campistry_link_parent.html) builds the PRIMARY camp's
--     children directly from get_parent_data_by_user()/claim_parent_invite()
--     (migration 035)'s response, which never returns camp_connected today.
--   - _augmentOtherCamps() builds every OTHER camp's children from
--     get_my_camps() (migration 070)'s response, which also never returns
--     camp_connected today.
--
-- So a parent whose only camper was deleted still sees that camper as a
-- perfectly normal card under "My Children" forever — exactly the "stale
-- child that isn't enrolled anywhere" the owner is now seeing live. Fix:
-- surface camp_connected from all three read paths so the client can hide
-- the CARD (this pass) while the underlying billing/photo name-matching
-- stays exactly as frozen as migration 122 intended.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. get_my_camps — add camp_connected alongside portal_active ─────────
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
        'camp_id',       i.camp_id,
        'camp_name',     coalesce(NULLIF(btrim(c.name), ''), 'Camp'),
        'parent_name',   i.parent_name,
        'parent_email',  i.parent_email,
        'family_id',     i.family_id,
        'camper_names',  i.camper_names,
        'camper_data',   i.camper_data,
        'camp_dates',    cd.value,
        'portal_active', (i.status = 'active'),
        'camp_connected', i.camp_connected
    ) ORDER BY coalesce(c.name,''), i.created_at), '[]'::jsonb)
    INTO result
    FROM link_parent_invites i
    LEFT JOIN camps c ON c.id = i.camp_id
    LEFT JOIN camp_state_kv cd ON cd.camp_id = i.camp_id AND cd.key = 'campDates'
    WHERE i.user_id = caller
      AND (i.status = 'active' OR i.billing_access = true)
      AND (i.expires_at IS NULL OR i.expires_at > now());

    RETURN jsonb_build_object('success', true, 'camps', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_camps() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_camps() TO authenticated;


-- ─── 2. get_parent_data_by_user — add camp_connected ───────────────────────
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
        RETURN jsonb_build_object('success', false, 'error', 'no_active_session');
    END IF;

    RETURN jsonb_build_object(
        'success',        true,
        'camp_id',        inv.camp_id,
        'parent_name',    inv.parent_name,
        'parent_email',   inv.parent_email,
        'family_id',      inv.family_id,
        'camper_names',   filtered->'names',
        'camper_data',    filtered->'data',
        'camp_connected', inv.camp_connected
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_parent_data_by_user() FROM public;
GRANT EXECUTE ON FUNCTION public.get_parent_data_by_user() TO authenticated;


-- ─── 3. claim_parent_invite — add camp_connected ───────────────────────────
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

    UPDATE link_parent_invites SET user_id = caller WHERE id = inv.id;

    filtered := public.link_filter_active_campers(inv.camper_names, inv.camper_data);
    IF (filtered->>'count')::int = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_session');
    END IF;

    RETURN jsonb_build_object(
        'success',        true,
        'camp_id',        inv.camp_id,
        'parent_name',    inv.parent_name,
        'parent_email',   inv.parent_email,
        'family_id',      inv.family_id,
        'camper_names',   filtered->'names',
        'camper_data',    filtered->'data',
        'camp_connected', inv.camp_connected
    );
END;
$$;
REVOKE ALL ON FUNCTION public.claim_parent_invite(text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_parent_invite(text) TO authenticated;


-- ─── Sanity check (run manually after applying) ────────────────────────────
--   As a parent whose only camper was deleted (camp_connected=false):
--   select get_parent_data_by_user(); -- expect camp_connected:false
--   select get_my_camps();            -- expect that camp's row to carry
--                                      -- camp_connected:false too
-- ============================================================================
