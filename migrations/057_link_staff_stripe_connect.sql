-- =============================================================================
-- Migration 057: Stripe Connect for Campistry Link tipping
--
-- link_tips / link_staff_accounts (migrations 016/017) already give Link a
-- full tip ledger — but nothing in it ever moved real money. Parents saw a
-- staff member's personal Venmo/Zelle handles with "the camp doesn't process
-- the payment here," and record_staff_payout() was just an admin manually
-- zeroing a balance after paying cash. This migration adds the columns
-- needed to attach a real Stripe Connect Express account to a staff row and
-- to tell a real Stripe-paid tip apart from a manually-recorded one.
--
-- Design note: for a Stripe-paid tip, money goes straight from the parent's
-- card to the staff member's own connected Stripe account via a destination
-- charge — the camp never holds it. So the webhook that lands these tips
-- (stripe-connect-webhook, see supabase/functions/) only ever increments
-- total_earned, never balance/total_paid_out — those stay reserved for the
-- existing cash/manual-payout flow (record_staff_payout). Mixing the two
-- would let an admin double-pay a connected staff member.
-- =============================================================================

-- ─── 1. link_staff_accounts: attach a Stripe Connect Express account ───────

ALTER TABLE link_staff_accounts
    ADD COLUMN IF NOT EXISTS stripe_account_id text,
    ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS stripe_onboarding_status text NOT NULL DEFAULT 'not_started',
    ADD COLUMN IF NOT EXISTS stripe_connected_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_staff_accounts_stripe_account
    ON link_staff_accounts (stripe_account_id)
    WHERE stripe_account_id IS NOT NULL;

-- ─── 2. link_tips: tell a real Stripe charge apart from a manual entry ─────

ALTER TABLE link_tips
    ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
    ADD COLUMN IF NOT EXISTS fee_amount numeric(8,2);

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_tips_stripe_pi
    ON link_tips (stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

-- ─── 3. get_staff_tip_account: surface connect status on the balance page ──

CREATE OR REPLACE FUNCTION public.get_staff_tip_account(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    acct link_staff_accounts;
    tips jsonb;
BEGIN
    IF p_code IS NULL OR btrim(p_code) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_code');
    END IF;

    SELECT * INTO acct FROM link_staff_accounts
    WHERE upper(access_code) = upper(btrim(p_code)) LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_code');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'amount', t.amount, 'camper_name', t.camper_name, 'created_at', t.created_at
    ) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO tips
    FROM (SELECT amount, camper_name, created_at FROM link_tips
          WHERE camp_id = acct.camp_id AND lower(recipient_name) = lower(acct.staff_name)
          ORDER BY created_at DESC LIMIT 50) t;

    -- stripe_account_id is deliberately never returned here — this RPC is
    -- anon-callable (code is the only credential), the account id isn't.
    RETURN jsonb_build_object(
        'success', true, 'staff_name', acct.staff_name, 'role', acct.role,
        'balance', acct.balance, 'total_earned', acct.total_earned,
        'total_paid_out', acct.total_paid_out, 'recent_tips', tips,
        'stripe_connected', acct.stripe_charges_enabled,
        'stripe_onboarding_status', acct.stripe_onboarding_status
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_staff_tip_account(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_staff_tip_account(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_staff_tip_account(text) TO authenticated;

-- ─── 4. get_link_tip_targets: narrow anon-facing list of tippable staff ────
-- Parents have no SELECT policy on link_staff_accounts at all (RLS is
-- owner/admin/scheduler-only) — this RPC is the only anon-facing window onto
-- it, and deliberately returns only what a parent needs to render a tip
-- button: never balance, access_code, or stripe_account_id.

CREATE OR REPLACE FUNCTION public.get_link_tip_targets(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE result jsonb;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp_id');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'staff_name', a.staff_name, 'role', a.role,
        'stripe_charges_enabled', a.stripe_charges_enabled
    )), '[]'::jsonb)
    INTO result
    FROM link_staff_accounts a
    WHERE a.camp_id = p_camp_id;

    RETURN jsonb_build_object('success', true, 'targets', result);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_link_tip_targets(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_tip_targets(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_link_tip_targets(uuid) TO authenticated;

-- ─── Sanity check ────────────────────────────────────────────────────────
-- select stripe_account_id, stripe_charges_enabled, stripe_onboarding_status
--   from link_staff_accounts limit 5;
-- select payment_method, stripe_payment_intent_id, fee_amount
--   from link_tips limit 5;
-- select get_link_tip_targets('00000000-0000-0000-0000-000000000000'::uuid);
