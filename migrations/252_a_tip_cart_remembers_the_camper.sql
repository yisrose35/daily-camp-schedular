-- ============================================================================
-- Migration 252: a tip paid from the cart remembers WHICH camper.
--
-- THE DEFECT. The parent portal's tip cart (stripe-connect-tip-cart) stores
-- each line in link_tip_cart_items with the camper's NAME only. When Stripe
-- confirms payment, stripe-connect-webhook copies the line into link_tips — by
-- name, and the table's trigger (223) then guesses the camper from that name.
-- A single tip (stripe-connect-tip) already carries the id through; the cart
-- did not.
--
-- THE FIX. The cart line carries person_id beside the name. The portal sends
-- each line's camperId (campistry_camper_id_rpc.js), the cart function stores
-- it, and the webhook writes it to link_tips, where an explicit id is kept as is.
--
-- HOW TO APPLY. Paste into the SQL Editor BEFORE redeploying
-- stripe-connect-tip-cart (which writes the column). Adds one nullable column.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regclass('public.link_tip_cart_items') IS NOT NULL THEN
        ALTER TABLE public.link_tip_cart_items ADD COLUMN IF NOT EXISTS person_id bigint;
    END IF;
END $$;
