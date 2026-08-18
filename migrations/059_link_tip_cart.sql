-- =============================================================================
-- Migration 059: One-checkout multi-recipient tipping (the "tip cart")
--
-- Today (migrations 057/058) a tip is a Stripe destination charge — one
-- PaymentIntent routes straight to one connected account via
-- transfer_data.destination. Stripe has no way to split a single
-- PaymentIntent across multiple destination accounts, so "tip 5 people in
-- one checkout" needs a different pattern: charge the parent ONCE into the
-- PLATFORM's own Stripe balance (no destination on the charge itself), then
-- fan that one payment out into separate Stripe Transfer objects — one per
-- recipient — the moment it succeeds. This is Stripe's own documented
-- pattern for "one payment, many payouts" (separate charges and transfers).
--
-- This also covers a parent with kids at multiple camps tipping everyone at
-- once: nothing here is camp-scoped beyond each individual cart line
-- carrying its own camp_id — a Transfer only cares about the destination
-- connected account, not which camp it belongs to.
--
-- Existing single-recipient stripe-connect-tip / destination-charge flow is
-- UNCHANGED and keeps working exactly as before — this is additive.
-- =============================================================================

-- ─── 1. link_tip_cart_items — the cart, one row per recipient ──────────────
-- No parent "cart" row: matches this feature's existing house style
-- (link_tips already denormalizes parent identity onto every row rather
-- than joining back to link_parent_invites). cart_id just groups the rows
-- created together for one checkout.
CREATE TABLE IF NOT EXISTS link_tip_cart_items (
    id                 uuid          NOT NULL DEFAULT gen_random_uuid(),
    cart_id            uuid          NOT NULL,
    camp_id            uuid          NOT NULL,
    staff_account_id   uuid          NOT NULL,
    staff_name         text          NOT NULL,
    staff_role         text          NOT NULL DEFAULT '',
    stripe_account_id  text          NOT NULL,
    camper_name        text,
    parent_user_id     uuid,
    parent_name        text,
    parent_email       text,
    tip_cents          integer       NOT NULL,
    fee_cents          integer       NOT NULL,   -- this item's own share of Campistry's 2% only — the shared Stripe processing fee is one combined line item on the Checkout Session, not attributed per recipient (see stripe-connect-tip-cart)
    created_at         timestamptz   NOT NULL DEFAULT now(),
    -- Fan-out bookkeeping — set by stripe-connect-webhook once this specific
    -- recipient's Transfer succeeds. NULL processed_at is what lets the
    -- webhook safely re-run on a retried delivery: it only re-attempts rows
    -- it hasn't finished yet, so a partial failure part-way through a cart
    -- can't double-pay anyone already paid.
    processed_at       timestamptz,
    stripe_transfer_id text,
    transfer_error     text,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_tip_cart_items_cart ON link_tip_cart_items (cart_id);

-- RLS enabled with NO policies at all — deliberate. This table is only ever
-- touched server-side: stripe-connect-tip-cart inserts rows with the
-- service-role client (same as its existing link_staff_accounts lookup,
-- since parents have no direct SELECT there either), and
-- stripe-connect-webhook reads/updates them the same way. No client of any
-- role should ever query this table directly.
ALTER TABLE link_tip_cart_items ENABLE ROW LEVEL SECURITY;

-- ─── 2. link_tips — add the FK the table always should have had ────────────
-- recipient_name/recipient_role (free text) were the only identity link
-- before this. staff_account_id is what makes the new idempotency key work
-- (see below) and lets a cart-processed tip and a destination-charge tip
-- both point at the same account unambiguously.
ALTER TABLE link_tips
    ADD COLUMN IF NOT EXISTS staff_account_id uuid,
    ADD COLUMN IF NOT EXISTS stripe_transfer_id text;

-- ─── 3. Idempotency key change — REQUIRED for carts to work at all ─────────
-- The old idx_link_tips_stripe_pi (UNIQUE on stripe_payment_intent_id alone)
-- assumed one PaymentIntent = one tip = one row. A cart checkout is one
-- PaymentIntent covering N recipients, so N rows now legitimately share a
-- stripe_payment_intent_id — the old unique index would reject every row
-- after the first. The correct uniqueness is per (payment_intent, staff
-- account): still exactly one row per recipient per charge, whether that
-- charge came from the single-recipient destination-charge flow (which
-- still gets exactly one row) or a cart (N rows, one per staff_account_id).
DROP INDEX IF EXISTS idx_link_tips_stripe_pi;
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_tips_pi_staff
    ON link_tips (stripe_payment_intent_id, staff_account_id)
    WHERE stripe_payment_intent_id IS NOT NULL AND staff_account_id IS NOT NULL;
-- Plain (non-unique) index so a lookup by payment_intent alone (e.g. support
-- debugging "what did this charge pay for") stays fast.
CREATE INDEX IF NOT EXISTS idx_link_tips_stripe_pi_lookup
    ON link_tips (stripe_payment_intent_id)
    WHERE stripe_payment_intent_id IS NOT NULL;

-- ─── Sanity check ────────────────────────────────────────────────────────
--   select cart_id, staff_name, tip_cents, fee_cents, processed_at, transfer_error
--     from link_tip_cart_items order by created_at desc limit 20;
--   select stripe_payment_intent_id, staff_account_id, amount, stripe_transfer_id
--     from link_tips order by created_at desc limit 20;
-- =============================================================================
