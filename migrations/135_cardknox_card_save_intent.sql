-- =============================================================================
-- Migration 135: let a cardknox_checkout_intents row represent a CARD SAVE,
-- not just a payment.
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
-- Amount is 0 for this kind. The webhook's amount-based fallback matching only
-- runs for amounts > 0, so a card save can never be mistaken for a payment.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE cardknox_checkout_intents
    DROP CONSTRAINT IF EXISTS cardknox_checkout_intents_kind_check;

ALTER TABLE cardknox_checkout_intents
    ADD CONSTRAINT cardknox_checkout_intents_kind_check
    CHECK (kind IN ('tuition_charge', 'canteen_deposit', 'card_save'));

-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'cardknox_checkout_intents_kind_check';
--   -- expect: CHECK (kind = ANY (ARRAY['tuition_charge','canteen_deposit','card_save']))
-- =============================================================================
