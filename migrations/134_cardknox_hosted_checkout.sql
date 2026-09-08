-- =============================================================================
-- Migration 134: Cardknox/Sola hosted checkout (PaymentSITE/"Sola Checkout")
-- + webhook support.
--
-- Real-world testing this session found the embedded iFields widget worked
-- but felt off to the user ("does not feel right why arent we on sola's
-- website"), and Cardknox/Sola turns out to have a genuine hosted, brandable
-- checkout page (confirmed live: https://secure.cardknox.com/<slug>) that
-- accepts a pre-filled amount via ?xAmount= and has a configurable webhook
-- (confirmed against docs.solapayments.com/products/webhooks, pasted in by
-- the user directly since every cardknox.com/solapayments.com doc domain is
-- network-blocked from this environment). This migration adds the pieces
-- needed to redirect a parent there instead of embedding iFields, and to
-- receive + verify Sola's async webhook notification of the result.
--
-- Sola's hosted checkout has no way to carry a JSON metadata blob (unlike a
-- Stripe Checkout Session) -- xInvoice is the one field designed for
-- exactly this "correlate a request to its later result" role (per Sola's
-- own Deep Linking docs: "xInvoice ... recommended when available for
-- improved duplicate handling"). So the flow is: we generate our own
-- reference, store a pending "intent" row keyed by it, pass it as xInvoice
-- when building the checkout URL, and the webhook resolves back to this row
-- via that same reference once Sola calls us back.
--
-- This table is deliberately NOT the source of truth for "did we already
-- credit this money" -- that idempotency guarantee already exists on the
-- crediting RPCs themselves (credit_canteen_balance_from_processor checks
-- for an existing byopTransactionId; the tuition credit path checks
-- byopTransactionId in finance.payments the same way). This table only
-- answers "what was this reference FOR" so the webhook handler knows who to
-- credit and how much.
--
-- Idempotent — safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cardknox_checkout_intents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    camp_id        uuid NOT NULL REFERENCES camps(id),
    reference      text NOT NULL UNIQUE,   -- what we pass as xInvoice
    kind           text NOT NULL CHECK (kind IN ('tuition_charge', 'canteen_deposit')),
    family_key     text,                   -- tuition
    family_name    text,                   -- tuition (display only)
    camper_name    text,                   -- canteen
    amount_cents   integer NOT NULL,
    description    text,
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    xref_num       text,                   -- Cardknox's own transaction id, filled in on completion
    created_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS cardknox_checkout_intents_camp_idx ON cardknox_checkout_intents (camp_id);
ALTER TABLE cardknox_checkout_intents ENABLE ROW LEVEL SECURITY;
-- No client-facing policies at all — every access goes through the
-- service_role-only RPCs below (same convention as camp_processor_credentials).

-- ─── create_cardknox_checkout_intent ────────────────────────────────────────
-- Called by the new cardknox-checkout-start edge function right before it
-- builds and returns the hosted checkout URL.
CREATE OR REPLACE FUNCTION public.create_cardknox_checkout_intent(
    p_camp_id      uuid,
    p_reference    text,
    p_kind         text,
    p_family_key   text,
    p_family_name  text,
    p_camper_name  text,
    p_amount_cents integer,
    p_description  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO cardknox_checkout_intents
        (camp_id, reference, kind, family_key, family_name, camper_name, amount_cents, description)
    VALUES
        (p_camp_id, p_reference, p_kind, p_family_key, p_family_name, p_camper_name, p_amount_cents, p_description);
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_already_used');
END;
$$;

REVOKE ALL ON FUNCTION public.create_cardknox_checkout_intent(uuid, text, text, text, text, text, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_cardknox_checkout_intent(uuid, text, text, text, text, text, integer, text) TO service_role;

-- ─── get_cardknox_checkout_intent ───────────────────────────────────────────
-- Called by cardknox-webhook once the ck-signature check passes, to resolve
-- xInvoice back to "what was this for."
CREATE OR REPLACE FUNCTION public.get_cardknox_checkout_intent(p_reference text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT CASE WHEN i.id IS NULL THEN jsonb_build_object('success', false, 'error', 'not_found')
                ELSE jsonb_build_object(
                    'success', true,
                    'campId', i.camp_id,
                    'kind', i.kind,
                    'familyKey', i.family_key,
                    'familyName', i.family_name,
                    'camperName', i.camper_name,
                    'amountCents', i.amount_cents,
                    'description', i.description,
                    'status', i.status
                )
           END
      FROM (SELECT 1) x
      LEFT JOIN cardknox_checkout_intents i ON i.reference = p_reference;
$$;

REVOKE ALL ON FUNCTION public.get_cardknox_checkout_intent(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cardknox_checkout_intent(text) TO service_role;

-- ─── mark_cardknox_checkout_intent_status ───────────────────────────────────
-- Best-effort bookkeeping only (see header note above) — never the guard
-- against double-crediting, just lets the office/support see what happened
-- to a given reference if they ever need to look.
CREATE OR REPLACE FUNCTION public.mark_cardknox_checkout_intent_status(
    p_reference text,
    p_status    text,
    p_xref_num  text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE cardknox_checkout_intents
       SET status = p_status,
           xref_num = COALESCE(p_xref_num, xref_num),
           completed_at = CASE WHEN p_status IN ('completed', 'failed') THEN now() ELSE completed_at END
     WHERE reference = p_reference;
$$;

REVOKE ALL ON FUNCTION public.mark_cardknox_checkout_intent_status(text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_cardknox_checkout_intent_status(text, text, text) TO service_role;

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT * FROM cardknox_checkout_intents LIMIT 1; -- expect empty table, no error
--   SELECT proacl FROM pg_proc WHERE proname IN
--     ('create_cardknox_checkout_intent','get_cardknox_checkout_intent','mark_cardknox_checkout_intent_status');
--   -- expect service_role only on all three
-- =============================================================================
