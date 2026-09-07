-- ============================================================================
-- Migration 123: fix get_my_link_features()'s multi-camp union logic.
--
-- Bug found by the owner testing migration 122: a parent with kids at TWO
-- different camps lost canteen/messages/etc. everywhere the moment ONE
-- camp's connection ended, even though their other kid is still fully
-- enrolled at the other camp.
--
-- Root cause: the old union step only looked at keys a camp's OWN map
-- explicitly mentioned:
--
--   FOR v_key IN SELECT jsonb_object_keys(v_camp) LOOP        -- only THIS
--       IF COALESCE((v_camp->>v_key)::boolean, true) THEN     -- camp's keys
--           v_union := jsonb_set(v_union, ARRAY[v_key], 'true', true);
--       ELSIF NOT (v_union ? v_key) THEN
--           v_union := jsonb_set(v_union, ARRAY[v_key], 'false', true);
--       END IF;
--   END LOOP;
--
-- A camp that runs canteen normally never puts a 'canteen' key in its map
-- at all (default-on means "say nothing"). So when Camp A explicitly sets
-- canteen:false (camp_connected, migration 122) and Camp B never mentions
-- canteen, Camp B's iteration never touches the 'canteen' key — it only
-- had the chance to vote while iterating ITS OWN keys — so Camp A's false
-- is never outvoted by anything, even though Camp B's silence should count
-- as "true" for Camp B specifically.
--
-- This bug already existed for the ORIGINAL camp-wide toggle path (one
-- camp manually disabling a program in Dashboard already had this same
-- flaw for a multi-camp parent) — migration 122 just made it fire
-- constantly instead of rarely, since every single-camp offboarding event
-- now sets 11 explicit false keys automatically.
--
-- Fix: two passes. First, collect every key ANY of the parent's camps ever
-- mentions. Then, for each such key, check EVERY camp: a camp that omits
-- the key defaults to true for that key, same as everywhere else in this
-- feature. The key is false in the union only if EVERY camp — mentioning
-- or omitting it — ends up false, which only happens when every single
-- camp EXPLICITLY set it false (silence never counts against a key).
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
    v_cmap     jsonb;
    v_key      text;
    v_cid      text;
    v_keys_seen jsonb := '{}'::jsonb;
    v_true_somewhere boolean;
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

        -- This parent's own connection to THIS camp ended (their last
        -- camper left the roster) — everything "live with the camp" goes
        -- dark for THIS camp only. payments and photos are deliberately
        -- excluded — those survive, off the frozen camper_names/
        -- camper_data snapshot this invite already carries.
        IF NOT inv.camp_connected THEN
            v_camp := jsonb_set(v_camp, '{canteen}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{shop}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{tips}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{mail}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{pickup}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{messages}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{schedule}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{forms}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{lists}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{health}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{emergency}', 'false'::jsonb, true);
        END IF;

        v_by_camp := jsonb_set(v_by_camp, ARRAY[inv.camp_id::text], v_camp, true);
    END LOOP;

    IF NOT v_any THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- Pass 1: every key ANY of the parent's camps ever mentions.
    FOR v_cid IN SELECT jsonb_object_keys(v_by_camp) LOOP
        v_cmap := v_by_camp->v_cid;
        FOR v_key IN SELECT jsonb_object_keys(v_cmap) LOOP
            v_keys_seen := jsonb_set(v_keys_seen, ARRAY[v_key], 'true'::jsonb, true);
        END LOOP;
    END LOOP;

    -- Pass 2: for each such key, false in the union ONLY if every single
    -- camp explicitly says false — a camp that never mentions the key
    -- defaults to true for that camp, and one "true" anywhere wins.
    FOR v_key IN SELECT jsonb_object_keys(v_keys_seen) LOOP
        v_true_somewhere := false;
        FOR v_cid IN SELECT jsonb_object_keys(v_by_camp) LOOP
            v_cmap := v_by_camp->v_cid;
            IF COALESCE((v_cmap->>v_key)::boolean, true) THEN
                v_true_somewhere := true;
                EXIT;
            END IF;
        END LOOP;
        v_union := jsonb_set(v_union, ARRAY[v_key], to_jsonb(v_true_somewhere), true);
    END LOOP;

    RETURN jsonb_build_object('success', true, 'features', v_union, 'byCamp', v_by_camp);
EXCEPTION WHEN OTHERS THEN
    -- Never let this break the portal: an error here should mean "show
    -- everything", which the client treats as the default.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
-- Grants unchanged by CREATE OR REPLACE — still authenticated-only, per 053.


-- ─── Sanity check (run manually after applying) ────────────────────────────
--   As a parent with an active, fully-connected invite at Camp A and a
--   camp_connected=false invite at Camp B: select get_my_link_features();
--   expect features.canteen/messages/etc. = true (Camp A's silence wins),
--   byCamp['<camp B id>'].canteen = false (Camp B's own map is unchanged).
--
--   As a parent with EVERY invite camp_connected=false: expect
--   features.canteen/messages/etc. = false (no camp anywhere says true),
--   features.payments/photos still absent (still enabled).
-- ============================================================================
