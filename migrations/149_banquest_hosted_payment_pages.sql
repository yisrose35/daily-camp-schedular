-- ============================================================================
-- Migration 149: Banquest redirect-to-hosted-page (Payment Pages) support.
--
-- Switches Banquest to the redirect model the user asked for: the parent
-- leaves Campistry, lands on Banquest's own hosted Payment Page, enters the
-- card there, and comes back — nothing card-related renders on our page.
--
-- Banquest's redirect primitive is Payment Pages:
--   POST /payment-pages/generate-pay-link/{slug}  { custom_fields, general_fields,
--        one_time_use:true, redirect_url }  →  { payment_link, key }
-- With one_time_use:true the response includes a unique tracking `key`, and the
-- redirect_url comes back with `?key=<key>` appended. That key is how we tie a
-- completed hosted payment back to the family/camper who started it:
--   GET /transactions?key=<key>  →  the transaction (status, reference_number,
--        custom_fields, card_details.last4, amount_details.amount).
--
-- This migration adds:
--   1. banquest_pending_links — the server-side map from a pay-link `key` to
--      what the parent was doing (which camp / family / camper / purpose /
--      amount), so the completion step knows what to record without trusting
--      anything the browser sends back beyond the opaque key.
--   2. Two extra Banquest credential fields:
--        paymentPageSlug   — the slug of the hosted Payment Page to pre-fill
--        webhookSignature  — the signing secret of the transaction.succeeded
--                            webhook (from POST /webhooks), used to verify
--                            inbound webhook deliveries. Optional: the
--                            poll-by-key completion path does not need it.
--
-- service_role owns the pending table; the edge functions (service role) are
-- the only readers/writers. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.banquest_pending_links (
    key              text PRIMARY KEY,
    camp_id          uuid NOT NULL,
    purpose          text NOT NULL CHECK (purpose IN ('save_card','pay_now','canteen')),
    family_key       text,
    camper_name      text,
    amount           numeric,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
    reference_number bigint,
    card_ref         text,
    last4            text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS banquest_pending_links_camp_idx
    ON public.banquest_pending_links (camp_id, created_at DESC);

ALTER TABLE public.banquest_pending_links ENABLE ROW LEVEL SECURITY;
-- No policies → only service_role (which bypasses RLS) can touch it. The edge
-- functions run as service role; the browser never reads or writes this table.
REVOKE ALL ON public.banquest_pending_links FROM anon, authenticated;

-- Housekeeping: a pending link that was never completed (parent abandoned the
-- hosted page, or an emailed pay link was never used) is dead after 30 days.
-- 30 (not 1) because an owner-generated pay link sent by email may be paid days
-- later; the row must still be there to complete it. Safe to call from a cron.
CREATE OR REPLACE FUNCTION public._admin_prune_banquest_pending_links()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_n integer;
BEGIN
    DELETE FROM public.banquest_pending_links
     WHERE status = 'pending' AND created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public._admin_prune_banquest_pending_links() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_prune_banquest_pending_links() TO service_role;

-- ── Banquest credential fields: add paymentPageSlug + webhookSignature ──────
UPDATE payment_processor_catalog
   SET credential_fields = '[
        {"key":"sourceKey","label":"Banquest Source Key","secret":true},
        {"key":"pin","label":"Banquest PIN","secret":true},
        {"key":"tokenizationKey","label":"Banquest Public Tokenization Key (pk_… — safe to expose client-side)","secret":false},
        {"key":"gatewayUrl","label":"API base URL (sandbox https://api.sandbox.banquestgateway.com/api/v2 · prod https://api.banquestgateway.com/api/v2)","secret":false},
        {"key":"tokenizationUrl","label":"Hosted tokenization script URL (e.g. https://tokenization.sandbox.banquestgateway.com/tokenization/v0.3)","secret":false},
        {"key":"paymentPageSlug","label":"Hosted Payment Page slug (from the Banquest dashboard — the page parents are redirected to)","secret":false},
        {"key":"webhookSignature","label":"Webhook signing secret (the signature returned by POST /webhooks for transaction.succeeded — optional; used to verify inbound webhooks)","secret":true}
       ]'::jsonb
 WHERE key = 'banquest';

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT * FROM banquest_pending_links LIMIT 1;          -- table exists
--   SELECT credential_fields FROM payment_processor_catalog WHERE key='banquest';
--   -- expect paymentPageSlug + webhookSignature present.
-- ============================================================================
