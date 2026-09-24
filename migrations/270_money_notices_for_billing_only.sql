-- ============================================================================
-- Migration 270: money notices go only to people who can see Billing; a
-- retried tip knows the parent's payment.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-087) ──────────────────────────────────────────────────
-- 1. The Dashboard shows the camp's notifications to every staff member who
--    can read them — schedulers included. "A card payment needs matching"
--    carries the amount and the masked card; "Autopay cannot collect", "card
--    expiring", chargebacks and payout failures name families and money. A
--    counselor with no Billing access saw all of it.
-- 2. The nightly retry of a failed tip transfer recorded the tip with no
--    parent payment id, so a dispute or refund looked up by payment missed
--    it — and the webhook's own duplicate check (by payment) could not see it.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- 1. The notifications read rule (098) is unchanged for everything else; the
--    money notices additionally need Billing (me.billing) at view or better,
--    decided by the same user_section_level the rest of the app's access uses.
-- 2. link_tip_cart_items.stripe_payment_intent_id: the webhook writes it on
--    every line of a paid cart, and the retry copies it onto the tip.
-- ============================================================================

-- ── 1. money notices ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_money_notice(p_source text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(p_source, '') IN (
        'payment_unmatched', 'autopay_blocked', 'chargeback', 'card_expiry',
        'parent_payment_plan_created', 'payout_failed');
$$;
GRANT EXECUTE ON FUNCTION public.is_money_notice(text) TO authenticated, service_role;

DROP POLICY IF EXISTS notifications_select ON notifications;
CREATE POLICY notifications_select ON notifications
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND (NOT public.is_money_notice(source)
             OR public.user_section_level(camp_id, 'me.billing') <> 'none')
    );

-- ── 2. a retried tip knows the parent's payment ─────────────────────────────
-- (Only where tip carts exist — migration 059.)
DO $$
BEGIN
    IF to_regclass('public.link_tip_cart_items') IS NOT NULL THEN
        ALTER TABLE public.link_tip_cart_items ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
    END IF;
END $$;
