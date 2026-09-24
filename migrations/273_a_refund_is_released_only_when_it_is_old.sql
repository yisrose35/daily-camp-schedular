-- ============================================================================
-- Migration 273: "nothing went through" can only release a refund that has
-- been waiting a few minutes.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once. Run it BEFORE redeploying payments-refund and
-- payments-canteen-refund.
--
-- ── THE PROBLEM (TED-093) ──────────────────────────────────────────────────
-- When the card company never answered a refund, the office is asked to check
-- the processor and confirm "nothing went through" before it is sent again. A
-- refund still RUNNING looks the same from outside: a double-click answered
-- the second click with that question, and confirming within those seconds
-- released the first click's claim and sent a second refund.
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- release_stale_refund_intent gives a claim back only if it was never settled
-- AND was taken at least three minutes ago — longer than any refund call runs.
-- A younger one answers false, and the office is told to wait and look again.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_stale_refund_intent(
    p_camp_id uuid,
    p_key     text,
    p_min_age interval DEFAULT interval '3 minutes'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_key text := NULLIF(btrim(COALESCE(p_key, '')), '');
BEGIN
    IF p_camp_id IS NULL OR v_key IS NULL THEN RETURN false; END IF;
    DELETE FROM refund_intents
     WHERE camp_id = p_camp_id AND key = v_key AND settled_at IS NULL
       AND created_at <= now() - GREATEST(COALESCE(p_min_age, interval '3 minutes'), interval '1 minute');
    RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.release_stale_refund_intent(uuid, text, interval) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stale_refund_intent(uuid, text, interval) TO service_role;
