-- ============================================================================
-- Migration 250: canteen refunds can read what they refund.
--
-- THE DEFECT. The four canteen refund edge functions (payments-canteen-refund,
-- payments-canteen-refund-all, stripe-canteen-refund, stripe-canteen-refund-all)
-- read balances and deposits through get_canteen_accounts — with the SERVICE
-- ROLE client. get_canteen_accounts decides what to show from the caller:
-- camp_staff_member() needs auth.uid(), which the service role does not have, and
-- camp_parent_campers() needs an invite. So it answered not_authorized, and every
-- canteen refund stopped at "Could not read canteen balance." — since the reader
-- was locked down (183), long before anything here.
--
-- And since 245 its staff ledger is a 7-DAY window, sized for the Snacks page.
-- A refund has to see every deposit the camper ever made on the card.
--
-- THE FIX. canteen_refund_view(camp): service-role only. Every live account,
-- carrying its camperId, and every ledger row that bears on a refund — the
-- credits (deposits, auto-reloads) and the refunds against them — for all time.
-- One row per deposit, so small even at 600 campers. The four functions read it,
-- match deposits to the camper by ID, and pass the id to the refund writer.
--
-- HOW TO APPLY. Paste into the SQL Editor, then redeploy the four functions
-- above. Touches no data (one nullable column is added to banquest_pending_links).
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public._canteen_tx_json(canteen_transactions)') IS NULL THEN
        RAISE EXCEPTION '250 needs _canteen_tx_json — apply 245 first';
    END IF;
END $$;

-- ─── and the hosted-payment link remembers WHICH camper ─────────────────────
-- payments-hosted-link stores the pending canteen payment here and
-- payments-hosted-complete credits it when Banquest sends the parent back. It
-- stored only the name; the id rides beside it now, and decides who is credited.
DO $$
BEGIN
    IF to_regclass('public.banquest_pending_links') IS NOT NULL THEN
        ALTER TABLE public.banquest_pending_links ADD COLUMN IF NOT EXISTS person_id bigint;
    END IF;
END $$;


CREATE OR REPLACE FUNCTION public.canteen_refund_view(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'success', true,
        'accounts', COALESCE((
            SELECT jsonb_object_agg(a.account_key, public._canteen_account_json(a)
                       || CASE WHEN a.person_id IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object('camperId', a.person_id) END)
              FROM camp_canteen_accounts a
             WHERE a.camp_id = p_camp_id AND a.deleted_at IS NULL), '{}'::jsonb),
        'transactions', COALESCE((
            SELECT jsonb_agg(public._canteen_tx_json(t) ORDER BY t.tx_date, t.first_seen)
              FROM canteen_transactions t
             WHERE t.camp_id = p_camp_id
               AND (t.tx_type = 'credit' OR t.payload ->> 'kind' = 'refund')), '[]'::jsonb))
$$;

REVOKE ALL ON FUNCTION public.canteen_refund_view(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canteen_refund_view(uuid) TO service_role;
