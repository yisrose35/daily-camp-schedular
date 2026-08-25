-- =============================================================================
-- Migration 087: Fix upsert_parent_invite silently un-claiming a parent's
-- portal login on every refresh.
--
-- Bug: the UPDATE branch of upsert_parent_invite (migration 011) has always
-- included `user_id = NULL` in its SET list. That RPC is called not just
-- when an office admin clicks "Get Invite Link" (a real, occasional action)
-- but also by _autoProvisionParentInvites — a SILENT background sync that
-- runs on essentially every save in Campistry Me (roster edit, bunk move,
-- staff change, etc.), and by "Sync Parent Portals" in Link admin. Every one
-- of those silent refreshes was wiping user_id back to NULL, which is
-- exactly the column claim_parent_invite / _parent_owns_camper use to know
-- a parent has already signed in and claimed this invite. In practice: a
-- parent who logged into Campistry Link could get silently logged out /
-- lose access the next time the camp office edited anything, with no error
-- on either side.
--
-- Fix: stop touching user_id on the update path entirely. Nothing else in
-- this function ever needs to reset a claim — claiming is claim_parent_
-- invite's job (migration 009), not upsert's. Byte-identical to migration
-- 011 otherwise; re-running this is safe.
-- =============================================================================

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

        -- user_id intentionally NOT reset here — see header comment. A
        -- parent who already claimed this invite (logged in) stays claimed
        -- across every refresh; only claim_parent_invite ever sets it.
        UPDATE link_parent_invites
        SET parent_name  = p_parent_name,
            camper_names = p_camper_names,
            camper_data  = p_camper_data,
            access_code  = v_code
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

-- ─── Sanity check ─────────────────────────────────────────────────────────────
-- Have a parent claim an invite (claim_parent_invite), confirm user_id is set.
-- Then trigger any camp-side save (roster edit) so _autoProvisionParentInvites
-- runs, or click "Sync Parent Portals" in Link admin. Re-check:
--   SELECT parent_email, user_id FROM link_parent_invites WHERE camp_id = '<camp>';
-- user_id should still be populated — previously it would have gone back to NULL.
-- =============================================================================
