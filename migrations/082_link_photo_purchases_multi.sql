-- =============================================================================
-- Migration 082: Link Photos — let one Checkout Session cover multiple kids
--
-- link_photo_purchases_pi_uq (migration 081) was UNIQUE on
-- stripe_payment_intent_id alone, on the assumption every purchase was for
-- exactly one camper or one photo. Parents with multiple kids need to turn
-- auto-matching on for all of them in a single checkout, which means one
-- PaymentIntent now legitimately backs several link_photo_purchases rows
-- (one per camper). The old index would have silently dropped every row
-- after the first via ON CONFLICT DO NOTHING.
--
-- Replaces it with a wider uniqueness key that still gives idempotency for
-- webhook retries (same payment_intent + same camper/photo = no-op) while
-- allowing distinct campers under the same payment_intent. kind is included
-- so a facial_recognition row and an hd_photo row can never collide even
-- though one of camper_name/photo_id is always null on each.
-- =============================================================================

DROP INDEX IF EXISTS public.link_photo_purchases_pi_uq;

CREATE UNIQUE INDEX IF NOT EXISTS link_photo_purchases_pi_uq
    ON public.link_photo_purchases (
        stripe_payment_intent_id,
        kind,
        COALESCE(camper_name, ''),
        COALESCE(photo_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE OR REPLACE FUNCTION public.record_link_photo_purchase(
    p_camp_id           uuid,
    p_parent_user_id    uuid,
    p_kind              text,
    p_camper_name       text,
    p_photo_id          uuid,
    p_amount_cents      integer,
    p_payment_intent_id text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO link_photo_purchases
        (camp_id, parent_user_id, kind, camper_name, photo_id, amount_paid_cents, stripe_payment_intent_id)
    VALUES
        (p_camp_id, p_parent_user_id, p_kind, p_camper_name, p_photo_id, p_amount_cents, p_payment_intent_id)
    ON CONFLICT (stripe_payment_intent_id, kind, (COALESCE(camper_name, '')), (COALESCE(photo_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    DO NOTHING;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select indexdef from pg_indexes where indexname = 'link_photo_purchases_pi_uq';
--   -- calling record_link_photo_purchase twice with the same payment_intent_id
--   -- but two different camper_names should insert TWO rows, not one.
-- =============================================================================
