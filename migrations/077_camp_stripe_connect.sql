-- =============================================================================
-- Migration 077: Stripe Connect for per-camp tuition/store billing.
--
-- Today every family's tuition/store payment (stripe-setup, stripe-charge,
-- stripe-checkout, charge-due-installments) lands in ONE shared platform
-- Stripe account, regardless of which camp the family belongs to. This
-- migration adds the columns needed to attach a real Stripe Connect Express
-- account to a camp, so tuition money can route directly to that camp's own
-- bank account instead of pooling into Campistry's account.
--
-- Mirrors migration 057 (link_staff_accounts' Stripe Connect columns, built
-- for the staff-tipping feature) verbatim, at the camps table instead of
-- link_staff_accounts. Same reasoning: a destination charge only needs the
-- connected account to RECEIVE a transfer, never to process a card itself —
-- card_payments stays a platform-only capability, the connected account
-- only ever needs capabilities[transfers].
--
-- This is entirely OPT-IN and backward compatible. Connecting a camp's
-- Stripe account is a separate step (see supabase/functions/
-- stripe-connect-onboard-camp) — adding these columns changes nothing for
-- any camp until they go through it. A camp with stripe_account_id IS NULL
-- (every camp, day one) charges exactly as it does today.
--
-- No platform fee on tuition (decided): camps keep 100% of what they
-- charge families. Onboarding is owner-only, not owner+admin: a camp's
-- bank-account connection is higher-stakes than ordinary billing actions,
-- same precedent already set for staff Stripe Connect onboarding.
-- =============================================================================

-- ─── 1. camps: attach a Stripe Connect Express account ─────────────────────

ALTER TABLE public.camps
    ADD COLUMN IF NOT EXISTS stripe_account_id text,
    ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS stripe_onboarding_status text NOT NULL DEFAULT 'not_started',
    ADD COLUMN IF NOT EXISTS stripe_connected_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_camps_stripe_account
    ON public.camps (stripe_account_id)
    WHERE stripe_account_id IS NOT NULL;

-- ─── 2. get_camp_stripe_status: safe read for the Dashboard card ───────────
-- stripe_account_id itself is deliberately never returned — no reason to
-- hand it to the browser (same reasoning as get_staff_tip_account never
-- returning link_staff_accounts.stripe_account_id). Any camp member (owner
-- or camp_users row) may READ status; only the owner may CONNECT — that's
-- enforced in stripe-connect-onboard-camp, not here.

CREATE OR REPLACE FUNCTION public.get_camp_stripe_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    row_data camps;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT * INTO row_data FROM camps WHERE id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'connected', row_data.stripe_account_id IS NOT NULL,
        'charges_enabled', row_data.stripe_charges_enabled,
        'onboarding_status', row_data.stripe_onboarding_status,
        'connected_at', row_data.stripe_connected_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_camp_stripe_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_stripe_status(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--   where table_name = 'camps' and column_name like 'stripe_%';
-- select get_camp_stripe_status('<a real camp id>'::uuid); -- as that camp's owner
-- =============================================================================
