-- ============================================================================
-- Migration 129: self-serve BYOP disconnect
--
-- Confirmed with the user: a camp owner/admin can DISCONNECT their own
-- connected processor (back to Stripe) directly from the Dashboard —
-- no office involvement needed for that direction. CONNECTING to a
-- non-Stripe processor stays office-assisted (migration 126/128's
-- admin-connect-processor, unchanged) — that's the direction with the
-- live-credential-handling liability; disconnecting just tears down what's
-- already there, so it's safe to self-serve.
--
-- Reconnecting to Stripe itself needs no new code — camps.payment_processor_key
-- flips back to 'stripe' here, and the EXISTING "Connect your Stripe
-- account" button (stripe-connect-onboard-camp) already handles the rest,
-- exactly as it does for any camp that never touched BYOP.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.disconnect_my_camp_processor(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
    v_uid   uuid := auth.uid();
    v_ok    boolean;
    v_secret_id uuid;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_uid
        UNION
        SELECT 1 FROM camp_users
         WHERE camp_id = p_camp_id AND user_id = v_uid
           AND accepted_at IS NOT NULL AND role IN ('owner', 'admin')
    ) INTO v_ok;
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT vault_secret_id INTO v_secret_id
      FROM camp_processor_credentials WHERE camp_id = p_camp_id;

    -- Clean up the Vault secret properly rather than leaving it orphaned —
    -- worth doing right now that this is a real self-serve action a camp
    -- can trigger repeatedly, not just a rare hand-run SQL statement.
    IF v_secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_secret_id;
    END IF;

    DELETE FROM camp_processor_credentials WHERE camp_id = p_camp_id;
    UPDATE camps SET payment_processor_key = 'stripe' WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.disconnect_my_camp_processor(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.disconnect_my_camp_processor(uuid) TO authenticated;

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'disconnect_my_camp_processor';
--   -- expect: grants to authenticated only.
-- ============================================================================
