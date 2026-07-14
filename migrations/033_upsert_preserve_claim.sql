-- ============================================================================
-- Migration 033: upsert_parent_invite must PRESERVE the parent's claim.
--
-- The refresh (UPDATE) branch used to set user_id = NULL — every snapshot
-- refresh silently DISCONNECTED an already-signed-up parent. Latent but rare
-- when refreshes were manual; fatal now that Me auto-provisions invites on
-- every roster change (a sibling added → parent kicked out of their portal).
--
-- A claim should only be cleared by an explicit revoke, never by a snapshot
-- refresh. Everything else (name/campers/data updated, token + access code
-- preserved) is unchanged.
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

    SELECT id, token, access_code
    INTO v_existing_id, v_existing_token, v_existing_code
    FROM link_parent_invites
    WHERE camp_id      = p_camp_id
      AND parent_email = p_parent_email
      AND status       = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
        v_code := COALESCE(
            NULLIF(v_existing_code, ''),
            upper(
                substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4) || '-' ||
                substring(replace(gen_random_uuid()::text, '-', '') from 5 for 4)
            )
        );

        UPDATE link_parent_invites
        SET parent_name  = p_parent_name,
            camper_names = p_camper_names,
            camper_data  = p_camper_data,
            access_code  = v_code
            -- user_id intentionally untouched: refreshing a snapshot must not
            -- disconnect a signed-up parent.
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
