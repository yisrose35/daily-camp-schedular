-- ============================================================================
-- Migration 130: self-serve "Disconnect from Stripe"
--
-- Mirrors migration 129's BYOP disconnect for the OTHER direction — a camp
-- that connected Stripe Connect (migration 077) can unlink it themselves,
-- same "tearing down an existing connection is safe to self-serve, handing
-- over a NEW credential is not" reasoning already applied to BYOP.
--
-- This clears Campistry's OWN record of the connection only
-- (camps.stripe_account_id/stripe_charges_enabled/stripe_onboarding_status/
-- stripe_connected_at) — it does NOT call Stripe's API to deactivate or
-- delete the underlying Express account on Stripe's own side. That account
-- just sits there unused going forward, same posture as a disconnected BYOP
-- credential's processor-side account (migration 129 doesn't try to
-- deactivate anything on Banquest/Cardknox's side either — only Campistry's
-- own reference to it). A camp can always reconnect (a fresh "Connect your
-- Stripe account" click creates or resumes an Express account) or connect a
-- BYOP processor afterward — this action doesn't preclude either.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.disconnect_my_camp_stripe(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_ok  boolean;
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

    UPDATE camps
       SET stripe_account_id = NULL,
           stripe_charges_enabled = false,
           stripe_onboarding_status = 'not_started',
           stripe_connected_at = NULL
     WHERE id = p_camp_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.disconnect_my_camp_stripe(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.disconnect_my_camp_stripe(uuid) TO authenticated;

-- ─── Sanity check (run manually after applying) ────────────────────────────
--   SELECT proname, proacl FROM pg_proc WHERE proname = 'disconnect_my_camp_stripe';
--   -- expect: grants to authenticated only.
-- ============================================================================
