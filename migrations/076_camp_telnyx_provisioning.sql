-- ============================================================================
-- Migration 076: camp_telnyx_provisioning — self-serve SMS number requests.
--
-- Why: getting a camp its own Telnyx number + 10DLC campaign (migration 075,
-- camps.telnyx_from_number) required the platform owner to manually buy the
-- number and register it in the Telnyx portal per camp. This table tracks
-- the lifecycle of a camp's own self-serve request end to end — payment,
-- Telnyx provisioning, and the async carrier-review wait — instead.
--
-- Holds a camp's Stripe customer ID and business tax ID (EIN), so it gets
-- the same lockdown as sms_opt_outs/email_unsubscribes (migrations 072-073):
-- RLS on, no client-side policy at all. Every read/write goes through
-- service-role edge functions only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS camp_telnyx_provisioning (
    camp_id                   uuid        PRIMARY KEY,
    status                    text        NOT NULL DEFAULT 'pending_payment',
    -- pending_payment | provisioning | pending_carrier_review | active | rejected | failed
    business_legal_name       text,
    ein                       text,
    business_address          text,
    business_email            text,
    business_phone            text,
    is_nonprofit              boolean     NOT NULL DEFAULT false,
    stripe_customer_id        text,
    stripe_payment_method_id  text,
    telnyx_phone_number       text,
    telnyx_number_id          text,
    telnyx_brand_id           text,
    telnyx_campaign_id        text,
    registration_fee_cents    integer,
    monthly_fee_cents         integer,
    next_charge_at            date,
    last_charged_at           timestamptz,
    error_message             text,
    requested_at              timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE camp_telnyx_provisioning ENABLE ROW LEVEL SECURITY;
-- No client-side SELECT/INSERT/UPDATE policy — every access goes through
-- SECURITY DEFINER RPCs or service-role edge functions, same pattern as
-- sms_opt_outs/email_unsubscribes.

-- ─── Read RPC for the Dashboard status card ───────────────────────────────
-- Returns only the safe-to-show subset — never the EIN, Stripe IDs, or raw
-- error internals beyond a short message. Staff-membership-gated the same
-- way as every other camp-scoped RPC in this schema (set_parent_invite_email,
-- get_camp_link_adoption, etc).
CREATE OR REPLACE FUNCTION public.get_camp_telnyx_status(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    row_data camp_telnyx_provisioning;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;

    SELECT * INTO row_data FROM camp_telnyx_provisioning WHERE camp_id = p_camp_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', true, 'exists', false);
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'exists', true,
        'status', row_data.status,
        'phone_number', row_data.telnyx_phone_number,
        'business_legal_name', row_data.business_legal_name,
        'business_address', row_data.business_address,
        'error_message', row_data.error_message,
        'requested_at', row_data.requested_at,
        'registration_fee_cents', row_data.registration_fee_cents,
        'monthly_fee_cents', row_data.monthly_fee_cents
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_telnyx_status(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_camp_telnyx_status(uuid) TO authenticated;

-- Sanity check after running:
--   SELECT to_regclass('public.camp_telnyx_provisioning');
--   SELECT proname FROM pg_proc WHERE proname = 'get_camp_telnyx_status';
