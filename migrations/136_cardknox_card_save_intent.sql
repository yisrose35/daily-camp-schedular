-- =============================================================================
-- Migration 136: let a cardknox_checkout_intents row represent a CARD SAVE
-- (tuition/family OR canteen auto-reload), not just a payment.
--
-- Sola's hosted checkout page (PaymentSITE) accepts ?xCommand=cc:save, which
-- tokenizes a card without charging anything — confirmed from the link Sola's
-- own "Send Payment Request" screen generates when TRANSACTION TYPE is set to
-- "save":
--   https://secure.cardknox.com/<slug>?AmountLocked=0&xCommand=cc%3Asave&xEnableRecurring=0
--
-- That closes the gap that made autopay unusable on a Cardknox camp: the only
-- way to get a reusable token on file was for the family to actually pay
-- something, because the office-side card page was Campistry-hosted (iFields)
-- rather than Sola's own. Now "Save a card" can send the family to the same
-- Sola page everything else uses, and the webhook stores the token it returns.
--
-- 'canteen_autoreload_setup' (added alongside 'card_save' rather than reusing
-- it) is the same cc:save flow but keyed to a CAMPER instead of a family —
-- canteen auto-reload's card lives on
-- campistrySnacks.accounts[camperName].autoReload, not families[famKey], so
-- it needs its own ownership check (campOwnsCamper, not campOwnsFamily) in
-- cardknox-checkout-start and its own webhook branch that writes to the
-- camper's autoReload block instead of the family record. Closes the other
-- half of the BYOP canteen gap: deposits already worked, but Add a
-- card/Update card for auto-reload was hardcoded to Stripe regardless of the
-- camp's actual processor.
--
-- Amount is 0 for both card-save kinds. The webhook's amount-based fallback
-- matching only runs for amounts > 0, so a card save can never be mistaken
-- for a payment.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE cardknox_checkout_intents
    DROP CONSTRAINT IF EXISTS cardknox_checkout_intents_kind_check;

ALTER TABLE cardknox_checkout_intents
    ADD CONSTRAINT cardknox_checkout_intents_kind_check
    CHECK (kind IN ('tuition_charge', 'canteen_deposit', 'card_save', 'canteen_autoreload_setup'));

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'cardknox_checkout_intents_kind_check';
--   -- expect: CHECK (kind = ANY (ARRAY['tuition_charge','canteen_deposit','card_save','canteen_autoreload_setup']))
-- =============================================================================
