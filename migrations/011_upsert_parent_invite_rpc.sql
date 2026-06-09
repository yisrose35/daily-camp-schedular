-- ============================================================================
-- Migration: upsert_parent_invite RPC
--
-- Why: the direct INSERT/UPDATE on link_parent_invites from the admin JS
-- client fails when get_user_camp_id() / get_user_role() don't satisfy the
-- RLS WITH CHECK clause (e.g. JWT claims mismatch).  Moving the write into
-- a SECURITY DEFINER function lets us bypass RLS entirely while keeping
-- the operation authenticated — the same pattern used by claim_parent_invite.
--
-- Self-contained: adds access_code column if it doesn't exist yet
-- (safe to run even if migration 010 was already applied).
-- ============================================================================

-- ─── 1. Ensure access_code column exists ─────────────────────────────────────
ALTER TABLE link_parent_invites
    ADD COLUMN IF NOT EXISTS access_code text;

-- ─── 2. upsert_parent_invite RPC ─────────────────────────────────────────────
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

        UPDATE link_parent_invites
        SET parent_name  = p_parent_name,
            camper_names = p_camper_names,
            camper_data  = p_camper_data,
            user_id      = NULL,
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
-- SELECT proname FROM pg_proc WHERE proname = 'upsert_parent_invite';
