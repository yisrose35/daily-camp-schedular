-- ============================================================================
-- Migration 131: reconnect a parent's camp on re-provision
--
-- Bug reported live: a camper was deleted, then re-added under the same
-- parent email — the camper never came back in Link (My Children, canteen,
-- messages, etc. all stayed missing for that family).
--
-- Root cause: migration 122 introduced link_parent_invites.camp_connected,
-- flipped to false by the offboarding sweep (revoke_orphaned_parent_invites)
-- when a parent's last camper leaves the roster. But upsert_parent_invite
-- (migration 087, unchanged since) never resets camp_connected back to true
-- on its UPDATE path — so re-adding the camper correctly refreshes
-- camper_names/camper_data via the existing auto-provision flow, but the
-- family stays permanently flagged as disconnected, and every camp_connected
-- check added in migrations 122/123/124 (get_my_link_features,
-- submit_shop_order, submit_camper_mail, submit_parent_message,
-- get_my_camps, get_parent_data_by_user, claim_parent_invite, and the
-- client's My Children card builder) keeps hiding/blocking that family.
--
-- Fix: upsert_parent_invite's UPDATE branch now also sets camp_connected =
-- true. Being called at all means _autoProvisionParentInvites found at
-- least one non-unenrolled camper for this parent+camp right now, so
-- reconnecting is always correct here — the offboarding sweep is what
-- disconnects a camp again if every camper leaves.
--
-- Byte-identical to migration 087 otherwise; idempotent, safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.upsert_parent_invite(
    p_camp_id      uuid,
    p_token        text,
    p_parent_name  text,
    p_parent_email text,
    p_camper_names jsonb,
    p_camper_data  jsonb,
    p_expires_at   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_existing_id    uuid;
    v_existing_token text;
    v_existing_code  text;
    v_code           text;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    -- Look for an existing active invite for this camp + parent email
    SELECT id, token, access_code
    INTO v_existing_id, v_existing_token, v_existing_code
    FROM link_parent_invites
    WHERE camp_id      = p_camp_id
      AND parent_email = p_parent_email
      AND status       = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
        -- Reuse existing code or generate a fresh one
        v_code := COALESCE(
            NULLIF(v_existing_code, ''),
            upper(
                substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4) || '-' ||
                substring(replace(gen_random_uuid()::text, '-', '') from 5 for 4)
            )
        );

        -- user_id intentionally NOT reset here — see migration 087's header
        -- comment. camp_connected IS reset here (new in this migration) —
        -- being called at all means this parent currently has at least one
        -- active camper for this camp, so any prior disconnect no longer
        -- applies.
        UPDATE link_parent_invites
        SET parent_name    = p_parent_name,
            camper_names   = p_camper_names,
            camper_data    = p_camper_data,
            access_code    = v_code,
            camp_connected = true
        WHERE id = v_existing_id;

        RETURN jsonb_build_object(
            'success',     true,
            'action',      'updated',
            'token',       v_existing_token,
            'access_code', v_code
        );
    ELSE
        v_code := upper(
            substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4) || '-' ||
            substring(replace(gen_random_uuid()::text, '-', '') from 5 for 4)
        );

        INSERT INTO link_parent_invites
            (camp_id, token, access_code, parent_name, parent_email,
             camper_names, camper_data, status, expires_at)
        VALUES
            (p_camp_id, p_token, v_code, p_parent_name, p_parent_email,
             p_camper_names, p_camper_data, 'active', p_expires_at);
        -- camp_connected defaults to true (migration 122's ADD COLUMN
        -- default) — nothing extra needed on the INSERT path.

        RETURN jsonb_build_object(
            'success',     true,
            'action',      'created',
            'token',       p_token,
            'access_code', v_code
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_parent_invite(uuid, text, text, text, jsonb, jsonb, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.upsert_parent_invite(uuid, text, text, text, jsonb, jsonb, timestamptz) TO authenticated;

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   1. Find a parent whose camp_connected is currently false:
--      SELECT id, parent_email, camp_connected FROM link_parent_invites WHERE camp_connected = false;
--   2. In Campistry Me, re-add/re-enroll a camper for that same parent email
--      (or trigger any save that re-runs _autoProvisionParentInvites).
--   3. Re-check the row — camp_connected should now be true, and that
--      family's camper/canteen/messages should reappear in Link.
-- ============================================================================
