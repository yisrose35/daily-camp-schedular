-- ============================================================================
-- Migration 108: fold camp_link_program_settings (migration 106, the camp
-- OWNER's own operational on/off switches) into get_my_link_features()
-- (migration 053, the platform's BILLING entitlements) so the parent app's
-- existing hide-what-you-don't-have mechanism covers both without any new
-- client-side code.
--
-- These two tables answer different questions — "did Campistry sell this
-- camp the feature" (link_camp_features, service-role-only) vs. "does this
-- camp actually run the program this year" (camp_link_program_settings,
-- owner/admin-writable) — but a parent only cares about the end result: is
-- this section actually usable. get_my_link_features() already builds a
-- {page: boolean} map per camp and unions it across a multi-camp parent's
-- invites; this just seeds that same per-camp map with BOTH sources before
-- the existing union logic runs, so a page is enabled only when neither
-- source says no. campistry_link_parent.html's lkLoadFeatures()/apply()/
-- guard() are completely unchanged — same RPC name, same response shape,
-- same data-page keys.
--
-- Key mapping: camp_link_program_settings' camperMail column maps to the
-- page key 'mail' (the actual data-page value in campistry_link_parent.html);
-- photos/canteen/shop/tips/pickup map 1:1 by name already.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_my_link_features()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_row      link_camp_features;
    v_progrow  camp_link_program_settings;
    v_union    jsonb := '{}'::jsonb;
    v_by_camp  jsonb := '{}'::jsonb;
    v_camp     jsonb;
    v_key      text;
    v_any      boolean := false;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    FOR inv IN
        SELECT * FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
    LOOP
        v_any := true;

        SELECT * INTO v_row FROM link_camp_features WHERE camp_id = inv.camp_id;
        v_camp := COALESCE(v_row.features, '{}'::jsonb);

        -- NEW: fold in the owner's own program toggles for this camp. Only
        -- write a key when the owner actually turned it OFF — an explicit
        -- true or an absent row must never override an existing false from
        -- link_camp_features (billing's "no" always wins over an owner
        -- trying to turn something back on they were never sold).
        SELECT * INTO v_progrow FROM camp_link_program_settings WHERE camp_id = inv.camp_id;
        IF FOUND THEN
            IF v_progrow.photos_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{photos}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.canteen_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{canteen}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.shop_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{shop}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.tips_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{tips}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.camper_mail_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{mail}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.pickup_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{pickup}', 'false'::jsonb, true);
            END IF;
        END IF;

        v_by_camp := jsonb_set(v_by_camp, ARRAY[inv.camp_id::text], v_camp, true);

        -- Union: a key is only false when EVERY camp says false. Seeding the
        -- union from each camp's own map means a key nobody mentions stays
        -- absent, and absent means enabled on the client.
        FOR v_key IN SELECT jsonb_object_keys(v_camp) LOOP
            IF COALESCE((v_camp->>v_key)::boolean, true) THEN
                v_union := jsonb_set(v_union, ARRAY[v_key], 'true'::jsonb, true);
            ELSIF NOT (v_union ? v_key) THEN
                v_union := jsonb_set(v_union, ARRAY[v_key], 'false'::jsonb, true);
            END IF;
        END LOOP;
    END LOOP;

    IF NOT v_any THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    RETURN jsonb_build_object('success', true, 'features', v_union, 'byCamp', v_by_camp);
EXCEPTION WHEN OTHERS THEN
    -- Never let this break the portal: an error here should mean "show
    -- everything", which the client treats as the default.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Grants unchanged by CREATE OR REPLACE — still authenticated-only, per 053.


-- ─── Sanity check (run manually after applying) ────────────────────────────
--   Turn a program off for a test camp via set_link_program_settings (or
--   directly: UPDATE camp_link_program_settings SET shop_enabled=false
--   WHERE camp_id='<uuid>'), then as a parent on that camp call
--   get_my_link_features() and confirm features.shop = false.
-- ============================================================================
