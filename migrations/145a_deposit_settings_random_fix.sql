-- =============================================================================
-- 145a — patch: mint inbound_token without pgcrypto
--
-- Migration 145 minted the per-camp inbound token with
-- encode(gen_random_bytes(16), 'hex'). gen_random_bytes is a PGCRYPTO
-- function, and Supabase installs pgcrypto into the `extensions` schema --
-- but every deposit RPC pins `SET search_path = public, pg_catalog`.
--
-- So 145 applied cleanly (tables + all 14 functions created), and the failure
-- only showed up at RUNTIME, on the one code path that mints a token: opening
-- Deposit Settings raised
--     function gen_random_bytes(integer) does not exist
-- which the Billing UI reported as the misleading "Migration 145 hasn't been
-- applied yet". The inbox itself worked the whole time, which is what made it
-- confusing.
--
-- gen_random_uuid() is core Postgres (13+), needs no extension, and gives the
-- same 128 bits. Stripping the dashes yields the same 32 hex characters, so
-- existing tokens and inbound addresses stay valid -- nothing is rotated.
--
-- Only these two functions ever minted a token, so this is the whole fix.
-- Safe to re-run. Run this AFTER 145.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_camp_deposit_settings(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_deposit_settings;
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_deposit_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    SELECT * INTO v_row FROM camp_deposit_settings WHERE camp_id = p_camp_id;

    RETURN jsonb_build_object(
        'success', true,
        'enabled', v_row.enabled,
        'inboundToken', v_row.inbound_token,
        'senderAllowlist', to_jsonb(v_row.sender_allowlist),
        'autoPostAt', v_row.auto_post_at,
        'suggestAt', v_row.suggest_at,
        'ambiguousGap', v_row.ambiguous_gap,
        'dryRun', v_row.dry_run
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_camp_deposit_settings(
    p_camp_id          uuid,
    p_enabled          boolean DEFAULT NULL,
    p_dry_run          boolean DEFAULT NULL,
    p_auto_post_at     integer DEFAULT NULL,
    p_suggest_at       integer DEFAULT NULL,
    p_ambiguous_gap    integer DEFAULT NULL,
    p_sender_allowlist text[]  DEFAULT NULL,
    p_rotate_token     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NOT _deposit_can_admin(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    INSERT INTO camp_deposit_settings (camp_id, inbound_token)
    VALUES (p_camp_id, replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (camp_id) DO NOTHING;

    UPDATE camp_deposit_settings SET
        enabled          = COALESCE(p_enabled, enabled),
        dry_run          = COALESCE(p_dry_run, dry_run),
        auto_post_at     = COALESCE(p_auto_post_at, auto_post_at),
        suggest_at       = COALESCE(p_suggest_at, suggest_at),
        ambiguous_gap    = COALESCE(p_ambiguous_gap, ambiguous_gap),
        sender_allowlist = COALESCE(p_sender_allowlist, sender_allowlist),
        inbound_token    = CASE WHEN p_rotate_token
                                THEN replace(gen_random_uuid()::text, '-', '')
                                ELSE inbound_token END,
        updated_at       = now()
     WHERE camp_id = p_camp_id;

    RETURN get_camp_deposit_settings(p_camp_id);
END;
$$;

-- CREATE OR REPLACE keeps existing grants, but 145 may have been applied in
-- pieces on a phone, so re-assert them.
GRANT EXECUTE ON FUNCTION public.get_camp_deposit_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_camp_deposit_settings(uuid, boolean, boolean, integer, integer, integer, text[], boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
