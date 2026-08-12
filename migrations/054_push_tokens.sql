-- ============================================================================
-- Migration 054: Device push tokens for the Campistry mobile apps.
--
-- A push token identifies ONE INSTALL, not one person: the same parent on a
-- phone and a tablet is two rows, and both should get the notification. The
-- token itself is the primary key, because Firebase and APNs reissue tokens and
-- an old one must be replaced rather than accumulate.
--
-- Which notifications a parent actually wants already lives in
-- link_parent_profiles.prefs (migration 051) — this table deliberately does not
-- duplicate that. The sender reads the preference, then looks up the devices.
-- ============================================================================

CREATE TABLE IF NOT EXISTS link_push_tokens (
    token       text        NOT NULL,
    user_id     uuid        NOT NULL,
    platform    text        NOT NULL,              -- 'android' | 'ios' | 'web'
    app         text        NOT NULL DEFAULT 'link', -- 'link' | 'lite'
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (token)
);

CREATE INDEX IF NOT EXISTS idx_link_push_tokens_user ON link_push_tokens (user_id);

ALTER TABLE link_push_tokens ENABLE ROW LEVEL SECURITY;

-- A user may see and remove their own device rows. Writes go through the RPC
-- below so the user_id can never be spoofed by the client.
DROP POLICY IF EXISTS link_push_tokens_self_select ON link_push_tokens;
CREATE POLICY link_push_tokens_self_select ON link_push_tokens
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS link_push_tokens_self_delete ON link_push_tokens;
CREATE POLICY link_push_tokens_self_delete ON link_push_tokens
    FOR DELETE USING (user_id = auth.uid());

-- ── Register / refresh this device ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_my_push_token(
    p_token    text,
    p_platform text,
    p_app      text DEFAULT 'link'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_token IS NULL OR btrim(p_token) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_token');
    END IF;

    -- The same token can move between accounts when two people share a device,
    -- so ownership is overwritten rather than kept: whoever signed in last is
    -- who this device now belongs to. Otherwise a parent could keep receiving
    -- another family's notifications after handing the phone over.
    INSERT INTO link_push_tokens (token, user_id, platform, app, updated_at)
    VALUES (btrim(p_token), v_uid, COALESCE(p_platform, 'unknown'), COALESCE(p_app, 'link'), now())
    ON CONFLICT (token) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            platform = EXCLUDED.platform,
            app = EXCLUDED.app,
            updated_at = now();

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ── Forget this device (sign-out, or notifications turned off) ───────────────
CREATE OR REPLACE FUNCTION public.forget_my_push_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    DELETE FROM link_push_tokens WHERE token = btrim(p_token) AND user_id = v_uid;
    RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_my_push_token(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.forget_my_push_token(text) TO authenticated;

-- ── Who should receive a given notification ──────────────────────────────────
-- For the SENDER (an Edge Function using the service role), not for clients.
-- Returns the device tokens of every parent at a camp who has that notification
-- type switched on. Absent preference = on, matching the app's own default.
CREATE OR REPLACE FUNCTION public.push_targets_for_camp(p_camp_id uuid, p_pref text)
RETURNS TABLE (token text, platform text, app text, user_id uuid)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT t.token, t.platform, t.app, t.user_id
    FROM link_push_tokens t
    WHERE t.user_id IN (
        SELECT i.user_id FROM link_parent_invites i
        WHERE i.camp_id = p_camp_id
          AND i.status = 'active'
          AND (i.expires_at IS NULL OR i.expires_at > now())
          AND i.user_id IS NOT NULL
    )
    AND COALESCE(
            (SELECT (p.prefs ->> p_pref)::boolean
             FROM link_parent_profiles p WHERE p.user_id = t.user_id),
            true
        ) IS TRUE;
$$;

-- Service role ONLY: this returns other people's device tokens and user ids.
-- Revoking from public and authenticated is NOT enough — Supabase grants
-- EXECUTE on new functions to anon as well, so an anonymous caller could still
-- run it. Verified against the live database: with only those two revokes it
-- answered an anonymous request instead of refusing it.
REVOKE ALL ON FUNCTION public.push_targets_for_camp(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.push_targets_for_camp(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.push_targets_for_camp(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.push_targets_for_camp(uuid, text) TO service_role;
